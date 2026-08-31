// Thin OpenClaw adapter for the anti-fixation watcher. Holds ALL gate/branch
// logic so openclaw/index.ts stays a single thin delegation per hook (keeps the
// large index.ts out of new branch coverage). Pure core lives in watcher-core.ts.
//
// Boundaries (see the approved plan): derived-state-only (a bounded, idle-evicted
// per-scope turn buffer reconstructable from host events), host-owned ids read
// not minted, deliver only past an allowing gate, and cooldown/dedup committed
// ONLY on a real host delivery id (a dropped send stays retryable). shadow_mode
// defaults ON so v1 is audit-only until explicitly promoted to live.
//
// The LLM critic / generator / moderator are INJECTED (real implementations land
// with the LLM layer). When they are absent on a live path the adapter
// fail-closes (no nudge) rather than masking with a permissive default.

import {
  createNeutralConversationContext,
  evaluateFixation,
  evaluateHostPolicyGate,
  type HostPolicyGateAudit,
  type InternalAntiFixationSignal,
  type NeutralConversationContext,
  type RawConversationMessage,
} from "./watcher-core.js";

export interface WatcherConfig {
  /** Opt-in; the watcher does nothing unless enabled. Default false. */
  enabled?: boolean;
  /** Evaluate + audit but never deliver. Default true. */
  shadowMode?: boolean;
  /** Min ms between deliveries for the same scope:fixationPattern. Default 600000. */
  cooldownMs?: number;
  /** Max critic calls per channel per hour. Default 20. */
  budgetPerHour?: number;
  /** Min critic confidence to deliver. Default 0.7. */
  confidenceThreshold?: number;
}

export interface WatcherLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface CriticResult {
  fixated: boolean;
  confidence: number;
}
export type WatcherCritic = (input: {
  signal: InternalAntiFixationSignal;
  context: NeutralConversationContext;
  recentTexts: string[];
}) => Promise<CriticResult | null>;
export type WatcherGenerator = (input: {
  signal: InternalAntiFixationSignal;
  context: NeutralConversationContext;
}) => Promise<string | null>;
export type WatcherModerator = (text: string) => boolean;
/** Host-native delivery: returns the host-assigned delivery id, or null if dropped. */
export interface WatcherDeliverOptions {
  /**
   * Host message id the steer should REPLACE in place (Mode B). The host decides
   * how: OpenClaw edits that Discord message; a host without an edit capability
   * falls back to posting the steer as a fresh message.
   */
  replaceMessageId?: string;
}
export type WatcherDeliver = (
  channelId: string,
  text: string,
  opts?: WatcherDeliverOptions,
) => Promise<string | null>;

export interface WatcherAdapterDeps {
  config?: WatcherConfig;
  logger: WatcherLogger;
  deliver: WatcherDeliver;
  critic?: WatcherCritic;
  generate?: WatcherGenerator;
  moderate?: WatcherModerator;
  /** Monotonic clock (ms) for cooldown/budget/eviction. Default Date.now. */
  now?: () => number;
  /** ISO clock for audit timestamps. Default new Date().toISOString. */
  isoNow?: () => string;
}

export const WATCHER_WINDOW_N = 8;
export const WATCHER_SCOPE_TTL_MS = 1_800_000; // 30 min idle eviction
export const WATCHER_MAX_SCOPES = 500;
const DEFAULT_COOLDOWN_MS = 600_000;
const DEFAULT_BUDGET_PER_HOUR = 20;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const HOUR_MS = 3_600_000;

interface ScopeBuffer {
  messages: RawConversationMessage[];
  lastTouched: number;
}

interface ChannelBudget {
  windowStart: number;
  count: number;
}

export interface OnAgentTurnArgs {
  scopeId: string;
  channelId: string;
  text: string;
  messageId: string;
  sourceThreadId?: string;
  targetThreadId?: string;
  sessionId?: string;
}

export interface OpenClawWatcherAdapter {
  recordUserTurn(scopeId: string, text: string, id?: string): void;
  onAgentTurn(args: OnAgentTurnArgs): Promise<HostPolicyGateAudit | null>;
  /** Number of live scope buffers (after eviction); for diagnostics/tests. */
  scopeCount(): number;
}

export function createOpenClawWatcherAdapter(deps: WatcherAdapterDeps): OpenClawWatcherAdapter {
  const cfg = deps.config ?? {};
  const shadowMode = cfg.shadowMode ?? true;
  const cooldownMs = cfg.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const budgetPerHour = cfg.budgetPerHour ?? DEFAULT_BUDGET_PER_HOUR;
  const confidenceThreshold = cfg.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const now = deps.now ?? (() => Date.now());
  const isoNow = deps.isoNow ?? (() => new Date().toISOString());

  const buffers = new Map<string, ScopeBuffer>();
  const budgets = new Map<string, ChannelBudget>();
  const lastDelivered = new Map<string, number>(); // cooldownKey -> ms
  const deliveredSignals = new Set<string>(); // signalId
  let seq = 0;

  function evictIdle(current: number): void {
    for (const [scopeId, buffer] of buffers) {
      if (current - buffer.lastTouched > WATCHER_SCOPE_TTL_MS) buffers.delete(scopeId);
    }
  }

  function push(scopeId: string, message: RawConversationMessage): RawConversationMessage[] {
    const current = now();
    evictIdle(current);
    let buffer = buffers.get(scopeId);
    if (buffer) {
      buffers.delete(scopeId); // re-insert at the tail so iteration order is LRU
    } else {
      buffer = { messages: [], lastTouched: current };
    }
    buffer.messages.push(message);
    if (buffer.messages.length > WATCHER_WINDOW_N) {
      buffer.messages = buffer.messages.slice(-WATCHER_WINDOW_N);
    }
    buffer.lastTouched = current;
    buffers.set(scopeId, buffer);
    while (buffers.size > WATCHER_MAX_SCOPES) {
      const lru = buffers.keys().next().value as string;
      buffers.delete(lru);
    }
    return buffer.messages;
  }

  function withinBudget(channelId: string, current: number): boolean {
    let budget = budgets.get(channelId);
    if (!budget || current - budget.windowStart >= HOUR_MS) {
      budget = { windowStart: current, count: 0 };
      budgets.set(channelId, budget);
    }
    if (budget.count >= budgetPerHour) return false;
    budget.count += 1;
    return true;
  }

  function recordUserTurn(scopeId: string, text: string, id?: string): void {
    seq += 1;
    push(scopeId, { id: id ?? `u-${seq}`, senderRole: "user", ts: isoNow(), text });
  }

  async function runLivePipeline(
    args: OnAgentTurnArgs,
    signal: InternalAntiFixationSignal,
    messages: RawConversationMessage[],
    cooldownKey: string,
    current: number,
  ): Promise<{ deliveryMessageId?: string; criticConfidence: number }> {
    if (!deps.critic || !deps.generate || !deps.moderate) {
      deps.logger.warn("watcher: live mode but LLM critic/generator/moderator missing, fail-closed");
      return { criticConfidence: 0 };
    }
    if (!withinBudget(args.channelId, current)) {
      deps.logger.warn(
        `watcher: critic budget exceeded for channel=${args.channelId}, fail-closed (no nudge)`,
      );
      return { criticConfidence: 0 };
    }
    try {
      const context = createNeutralConversationContext(args.scopeId, messages);
      const verdict = await deps.critic({ signal, context, recentTexts: messages.map((m) => m.text) });
      if (!verdict) {
        deps.logger.warn("watcher: critic returned null, fail-closed (no nudge)");
        return { criticConfidence: 0 };
      }
      if (!verdict.fixated || verdict.confidence < confidenceThreshold) {
        return { criticConfidence: verdict.confidence };
      }
      const text = await deps.generate({ signal, context });
      if (!text || !deps.moderate(text)) {
        deps.logger.warn("watcher: nudge suppressed (empty generation or moderation failed)");
        return { criticConfidence: verdict.confidence };
      }
      const deliveryMessageId = await deps.deliver(args.channelId, text, {
        replaceMessageId: args.messageId,
      });
      if (deliveryMessageId) {
        lastDelivered.set(cooldownKey, current);
        deliveredSignals.add(`${args.scopeId}:${signal.signalId}`);
      }
      return { deliveryMessageId: deliveryMessageId ?? undefined, criticConfidence: verdict.confidence };
    } catch {
      deps.logger.warn("watcher: LLM pipeline raised, fail-closed (no nudge)");
      return { criticConfidence: 0 };
    }
  }

  async function onAgentTurn(args: OnAgentTurnArgs): Promise<HostPolicyGateAudit | null> {
    const messages = push(args.scopeId, {
      id: args.messageId,
      senderRole: "agent",
      ts: isoNow(),
      text: args.text,
      threadId: args.sourceThreadId,
      sessionId: args.sessionId,
    });
    if (!cfg.enabled) return null;

    const signal = evaluateFixation(messages, args.scopeId)[0];
    if (!signal) return null;

    const cooldownKey = `${args.scopeId}:${signal.fixationPattern}`;
    const current = now();
    const cooldownHit = current - (lastDelivered.get(cooldownKey) ?? Number.NEGATIVE_INFINITY) < cooldownMs;
    const duplicateHit = deliveredSignals.has(`${args.scopeId}:${signal.signalId}`);

    let deliveryMessageId: string | undefined;
    let criticConfidence = 0;
    if (!shadowMode && !cooldownHit && !duplicateHit) {
      const outcome = await runLivePipeline(args, signal, messages, cooldownKey, current);
      deliveryMessageId = outcome.deliveryMessageId;
      criticConfidence = outcome.criticConfidence;
    }

    const audit = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal,
      criticConfidence,
      sourceThreadId: args.sourceThreadId,
      targetThreadId: args.targetThreadId,
      sessionId: args.sessionId,
      shadowMode,
      cooldownHit,
      duplicateHit,
      deliveryMessageId,
      now: isoNow(),
    });
    deps.logger.info(
      `watcher: scope=${args.scopeId} pattern=${signal.fixationPattern} allowed=${audit.allowed}` +
        ` delivered=${deliveryMessageId ? "yes" : "no"}` +
        `${audit.suppressedReason ? ` suppressed=${audit.suppressedReason}` : ""}`,
    );
    return audit;
  }

  return { recordUserTurn, onAgentTurn, scopeCount: () => buffers.size };
}
