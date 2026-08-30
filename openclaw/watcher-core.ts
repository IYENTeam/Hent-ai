// Pure, side-effect-free reimplementation of the conversation-watcher
// anti-fixation core for hent-ai. conversation-watcher (IYENTeam) is a DESIGN
// REFERENCE only — no external dependency is consumed. See the approved plan
// .gjc/plans/ralplan/2026-06-18-0155-3fca/stage-03-final.md.
//
// This module is deterministic and has no I/O and no LLM calls so it can be
// covered to 100% and kept in lockstep with the Python port (hermes/watcher_core.py)
// via the shared golden fixtures. The pinned tokenizer / stop-word list /
// epsilon comparison below are the parity contract: changing them requires
// updating both surfaces and the golden fixtures together.

export const DEFAULT_NOW = "2026-06-16T00:00:00.000Z";

export const PRIORITY_STACK = [
  "latest_explicit_instruction",
  "active_nudge",
  "current_topic",
  "older_summary",
] as const;
export type PriorityStackEntry = (typeof PRIORITY_STACK)[number];

export type RuntimeName = "openclaw" | "hermes";
export type SenderRole = "user" | "agent" | "system";
export type GateCheckVerdict = "passed" | "blocked" | "not_applicable";
export type FixationPattern =
  | "stale_expression_repeated"
  | "new_context_ignored_previous_frame_repeated";

export interface RawConversationMessage {
  id: string;
  senderRole: SenderRole;
  ts: string;
  text: string;
  threadId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export type NudgeKind =
  | "tone"
  | "angle"
  | "hypothesis"
  | "priority"
  | "constraint"
  | "exploration"
  | "format";
export type NudgeStrength = "weak" | "normal" | "strong";

/**
 * A soft, in-conversation steering hint derived from the neutral context. Not
 * delivered directly; it informs the prompt-context priority stack. Retained in
 * the core for parity with the reference schema and for prompt-context work that
 * lands with the adapters (see PRIORITY_STACK).
 */
export interface ContextNudge {
  schema: "conversation_watcher.context_nudge.v1";
  scopeId: string;
  sourceMessageId: string;
  authorId?: string;
  kind: NudgeKind;
  instruction: string;
  strength: NudgeStrength;
  lifetime: { mode: "turns" | "messages" | "minutes" | "until_replaced"; value: number | null };
  priority: number;
  safetyBoundary: "soft_steering_not_policy_override";
  createdAt: string;
  expiresAt: string | null;
}

export interface ConversationDiscontinuity {
  fromMessageId: string;
  toMessageId: string;
  kind: "topic" | "intent";
  summary: string;
}

export interface NeutralConversationContext {
  schema: "conversation_watcher.neutral_context.v1";
  scopeId: string;
  sourceMessageIds: string[];
  currentTopic: string;
  latestExplicitInstruction: string | null;
  recentUserIntent: string | null;
  openQuestions: string[];
  contextDiscontinuities: ConversationDiscontinuity[];
  summary: string;
  confidence: number;
  createdAt: string;
}

export interface InternalAntiFixationSignal {
  schema: "conversation_watcher.internal_anti_fixation_signal.v1";
  signalId: string;
  scopeId: string;
  reason: string;
  staleFrame: string;
  newContextEvidence: string;
  suggestedPivot: string;
  sourceMessageIds: string[];
  confidence: number;
  severity: "low" | "medium" | "high";
  fixationPattern: FixationPattern;
  createdAt: string;
}

export interface ExternalNudge {
  schema: "conversation_watcher.external_nudge.v1";
  nudgeId: string;
  scopeId: string;
  target: { runtime: RuntimeName; channel?: string; threadId?: string; sessionId?: string };
  text: string;
  whyNow: string;
  suggestedPivot: string;
  sourceMessageIds: string[];
  internalSignalId: string;
  identityDisclosure: "agent_explicit";
  createdAt: string;
}

export interface GateCheckResult {
  verdict: GateCheckVerdict;
  reason: string;
}

export interface HostPolicyGateAudit {
  schema: "conversation_watcher.host_policy_gate_audit.v1";
  runtime: RuntimeName;
  allowed: boolean;
  reason: string;
  threadId?: string;
  sessionId?: string;
  sourceMessageIds: string[];
  cooldownKey: string;
  duplicateCheck: GateCheckResult;
  privacyCheck: GateCheckResult;
  threadCheck: GateCheckResult;
  criticConfidence: number;
  fixationPattern: FixationPattern;
  internalSignalId: string;
  deliveryMessageId?: string;
  suppressedReason?: string;
  createdAt: string;
}

export interface GoldenReplayFixture {
  name: string;
  description: string;
  scopeId: string;
  rawMessages: RawConversationMessage[];
  expectedFixated: boolean;
  expectedPatterns: FixationPattern[];
}

// --------------------------------------------------------------------------
// Pinned deterministic helpers (parity contract with hermes/watcher_core.py)
// --------------------------------------------------------------------------

export const STOP_WORDS: ReadonlySet<string> = new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of", "in",
  "on", "for", "is", "are", "was", "were", "be", "been", "it", "this", "that",
  "i", "you", "we", "they", "as", "at", "by", "with", "about",
  "은", "는", "이", "가", "을", "를", "에", "의", "도", "로", "으로", "고", "과", "와",
]);

export const SIMILARITY_EPSILON = 1e-9;

export function compact(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function hasAny(text: string, needles: string[]): boolean {
  const lowered = text.toLowerCase();
  return needles.some((needle) => lowered.includes(needle.toLowerCase()));
}

/** Pinned tokenizer: lowercase, keep unicode letter/number runs, drop stop words. */
export function tokenize(text: string): string[] {
  const matched = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return matched.filter((token) => !STOP_WORDS.has(token));
}

export function inferTopic(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return "conversation";
  return tokens.slice(0, 4).join(" ");
}

export function latestInstruction(text: string): string | null {
  if (
    hasAny(text, [
      "don't", "do not", "stop", "instead", "rather",
      "아니", "하지마", "하지 마", "말고", "대신", "그만",
    ])
  ) {
    return compact(text, 160);
  }
  return null;
}

export function check(verdict: GateCheckVerdict, reason: string): GateCheckResult {
  return { verdict, reason };
}

export function approxGte(value: number, threshold: number, epsilon = SIMILARITY_EPSILON): boolean {
  return value >= threshold - epsilon;
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function bigrams(tokens: string[]): string[] {
  const grams: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    grams.push(`${tokens[i - 1]} ${tokens[i]}`);
  }
  return grams;
}

/** Max of token-set Jaccard and bigram-set Jaccard between two texts. */
export function similarity(aText: string, bText: string): number {
  const aTokens = tokenize(aText);
  const bTokens = tokenize(bText);
  const tokenSim = jaccard(aTokens, bTokens);
  const gramSim = jaccard(bigrams(aTokens), bigrams(bTokens));
  return Math.max(tokenSim, gramSim);
}

export function maxPairwiseSimilarity(texts: string[]): number {
  let max = 0;
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const sim = similarity(texts[i]!, texts[j]!);
      if (sim > max) max = sim;
    }
  }
  return max;
}

export function trailingTopicRun(topics: string[]): number {
  if (topics.length === 0) return 0;
  let run = 1;
  for (let i = topics.length - 1; i > 0; i -= 1) {
    if (topics[i] === topics[i - 1]) run += 1;
    else break;
  }
  return run;
}

// --------------------------------------------------------------------------
// Detection
// --------------------------------------------------------------------------

export interface FixationOptions {
  windowN?: number;
  persistenceK?: number;
  simThreshold?: number;
  persistenceSimFloor?: number;
  now?: string;
}

export const DEFAULT_WINDOW_N = 8;
export const DEFAULT_PERSISTENCE_K = 3;
export const DEFAULT_SIM_THRESHOLD = 0.6;
export const DEFAULT_PERSISTENCE_SIM_FLOOR = 0.4;

/**
 * High-recall self-repetition prefilter. Fires when the agent restates
 * near-duplicate content across recent turns (no user correction required),
 * OR stays stuck on the same frame for several moderately-similar turns. It is
 * intentionally permissive; the downstream LLM critic is the precision gate.
 */
export function detectStaleRepetition(
  messages: RawConversationMessage[],
  scopeId: string,
  options: FixationOptions = {},
): InternalAntiFixationSignal[] {
  const windowN = options.windowN ?? DEFAULT_WINDOW_N;
  const persistenceK = options.persistenceK ?? DEFAULT_PERSISTENCE_K;
  const simThreshold = options.simThreshold ?? DEFAULT_SIM_THRESHOLD;
  const floor = options.persistenceSimFloor ?? DEFAULT_PERSISTENCE_SIM_FLOOR;
  const now = options.now ?? DEFAULT_NOW;

  const window = messages.filter((m) => m.senderRole === "agent").slice(-windowN);
  if (window.length < 2) return [];

  const maxSim = maxPairwiseSimilarity(window.map((m) => m.text));
  const persistence = trailingTopicRun(window.map((m) => inferTopic(m.text)));
  const repetition = approxGte(maxSim, simThreshold);
  const stuck = persistence >= persistenceK && approxGte(maxSim, floor);
  if (!repetition && !stuck) return [];

  const last = window[window.length - 1]!;
  const staleFrame = inferTopic(last.text);
  return [
    {
      schema: "conversation_watcher.internal_anti_fixation_signal.v1",
      signalId: `sig-stale-${last.id}`,
      scopeId,
      reason: repetition
        ? "Agent is restating near-duplicate content across recent turns."
        : "Agent has stayed on the same frame across consecutive turns.",
      staleFrame,
      newContextEvidence: repetition
        ? "near-duplicate restatement across recent agent turns"
        : `same frame across ${persistence} consecutive agent turns`,
      suggestedPivot: `Move past "${staleFrame}" and offer a genuinely fresh angle.`,
      sourceMessageIds: window.map((m) => m.id),
      confidence: 0.6,
      severity: repetition ? "high" : "medium",
      fixationPattern: "stale_expression_repeated",
      createdAt: now,
    },
  ];
}

/**
 * Additional reference-style signal: the agent repeats the previous frame even
 * after the user issued a newer explicit instruction. Retained as a secondary
 * signal only; it is NOT the primary trigger.
 */
export function detectCorrectionDrivenFixation(
  messages: RawConversationMessage[],
  scopeId: string,
  options: FixationOptions = {},
): InternalAntiFixationSignal[] {
  const now = options.now ?? DEFAULT_NOW;
  const signals: InternalAntiFixationSignal[] = [];
  for (let i = 2; i < messages.length; i += 1) {
    const prevAgent = messages[i - 2]!;
    const correction = messages[i - 1]!;
    const currentAgent = messages[i]!;
    if (
      prevAgent.senderRole !== "agent" ||
      correction.senderRole !== "user" ||
      currentAgent.senderRole !== "agent"
    ) {
      continue;
    }
    const corrected = latestInstruction(correction.text) !== null;
    const repeatedFrame = inferTopic(prevAgent.text) === inferTopic(currentAgent.text);
    const newTopic = inferTopic(correction.text);
    if (corrected && repeatedFrame && inferTopic(currentAgent.text) !== newTopic) {
      signals.push({
        schema: "conversation_watcher.internal_anti_fixation_signal.v1",
        signalId: `sig-correction-${currentAgent.id}`,
        scopeId,
        reason: "Agent repeated the previous frame after a newer explicit instruction.",
        staleFrame: inferTopic(prevAgent.text),
        newContextEvidence: `${correction.id}: ${compact(correction.text, 120)}`,
        suggestedPivot: `Answer from the newer frame: ${newTopic}.`,
        sourceMessageIds: [prevAgent.id, correction.id, currentAgent.id],
        confidence: 0.9,
        severity: "high",
        fixationPattern: "new_context_ignored_previous_frame_repeated",
        createdAt: now,
      });
    }
  }
  return signals;
}

export function evaluateFixation(
  messages: RawConversationMessage[],
  scopeId: string,
  options: FixationOptions = {},
): InternalAntiFixationSignal[] {
  return [
    ...detectStaleRepetition(messages, scopeId, options),
    ...detectCorrectionDrivenFixation(messages, scopeId, options),
  ];
}

export function createNeutralConversationContext(
  scopeId: string,
  messages: RawConversationMessage[],
  now = DEFAULT_NOW,
): NeutralConversationContext {
  const users = messages.filter((m) => m.senderRole === "user");
  const lastUser = users[users.length - 1];
  const instruction =
    [...users].reverse().map((m) => latestInstruction(m.text)).find(Boolean) ?? null;
  const discontinuities: ConversationDiscontinuity[] = [];
  for (let i = 1; i < users.length; i += 1) {
    const prev = users[i - 1]!;
    const cur = users[i]!;
    const prevTopic = inferTopic(prev.text);
    const curTopic = inferTopic(cur.text);
    if (prevTopic !== curTopic) {
      discontinuities.push({
        fromMessageId: prev.id,
        toMessageId: cur.id,
        kind: latestInstruction(cur.text) ? "intent" : "topic",
        summary: `Context moved from "${prevTopic}" to "${curTopic}".`,
      });
    }
  }
  return {
    schema: "conversation_watcher.neutral_context.v1",
    scopeId,
    sourceMessageIds: messages.map((m) => m.id),
    currentTopic: lastUser ? inferTopic(lastUser.text) : "conversation",
    latestExplicitInstruction: instruction,
    recentUserIntent: lastUser ? compact(lastUser.text, 120) : null,
    openQuestions: users
      .filter((m) => /[?？까]\s*$/.test(m.text.trim()))
      .map((m) => compact(m.text, 120)),
    contextDiscontinuities: discontinuities,
    summary: compact(messages.map((m) => `${m.senderRole}: ${m.text}`).join(" | "), 280),
    confidence: messages.length ? 0.82 : 0.1,
    createdAt: now,
  };
}

export function planExternalNudge(
  runtime: RuntimeName,
  signal: InternalAntiFixationSignal,
  text: string,
  target: { channel?: string; threadId?: string; sessionId?: string } = {},
  now = DEFAULT_NOW,
): ExternalNudge {
  return {
    schema: "conversation_watcher.external_nudge.v1",
    nudgeId: `nudge-${signal.signalId}`,
    scopeId: signal.scopeId,
    target: { runtime, ...target },
    text,
    whyNow: signal.reason,
    suggestedPivot: signal.suggestedPivot,
    sourceMessageIds: signal.sourceMessageIds,
    internalSignalId: signal.signalId,
    identityDisclosure: "agent_explicit",
    createdAt: now,
  };
}

export interface HostPolicyGateInput {
  runtime: RuntimeName;
  signal: InternalAntiFixationSignal;
  criticConfidence: number;
  sourceThreadId?: string;
  targetThreadId?: string;
  sessionId?: string;
  shadowMode?: boolean;
  cooldownHit?: boolean;
  duplicateHit?: boolean;
  privacyRisk?: boolean;
  crossThreadRisk?: boolean;
  deliveryMessageId?: string;
  now?: string;
}

export function evaluateHostPolicyGate(input: HostPolicyGateInput): HostPolicyGateAudit {
  const threadMatches =
    !input.sourceThreadId || !input.targetThreadId || input.sourceThreadId === input.targetThreadId;
  const threadOk = threadMatches && !input.crossThreadRisk;
  const threadReason = input.crossThreadRisk
    ? "signal sources span multiple threads"
    : threadMatches
      ? "thread matches or is unspecified"
      : "source and target thread mismatch";
  const suppressedReason = input.shadowMode
    ? "shadow_mode"
    : input.cooldownHit
      ? "cooldown"
      : input.duplicateHit
        ? "duplicate"
        : input.privacyRisk
          ? "privacy"
          : !threadOk
            ? "thread_mismatch"
            : undefined;
  const allowed = suppressedReason === undefined;
  return {
    schema: "conversation_watcher.host_policy_gate_audit.v1",
    runtime: input.runtime,
    allowed,
    reason: allowed ? "host policy gate allowed native delivery" : `suppressed: ${suppressedReason}`,
    threadId: input.targetThreadId,
    sessionId: input.sessionId,
    sourceMessageIds: input.signal.sourceMessageIds,
    cooldownKey: `${input.signal.scopeId}:${input.signal.fixationPattern}`,
    duplicateCheck: check(
      input.duplicateHit ? "blocked" : "passed",
      input.duplicateHit ? "duplicate nudge" : "no duplicate",
    ),
    privacyCheck: check(
      input.privacyRisk ? "blocked" : "passed",
      input.privacyRisk ? "privacy risk" : "no privacy risk",
    ),
    threadCheck: check(threadOk ? "passed" : "blocked", threadReason),
    criticConfidence: input.criticConfidence,
    fixationPattern: input.signal.fixationPattern,
    internalSignalId: input.signal.signalId,
    deliveryMessageId: allowed ? input.deliveryMessageId : undefined,
    suppressedReason,
    createdAt: input.now ?? DEFAULT_NOW,
  };
}

/** Run the pure pipeline over a fixture and return the structured result used by parity tests. */
export function evaluateFixtureResult(
  fixture: GoldenReplayFixture,
  options: FixationOptions = {},
): { fixated: boolean; patterns: FixationPattern[] } {
  const signals = evaluateFixation(fixture.rawMessages, fixture.scopeId, options);
  return {
    fixated: signals.length > 0,
    patterns: signals.map((s) => s.fixationPattern),
  };
}
