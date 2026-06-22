import type { ServiceDatabase } from "./db.js";
import type { ConversationServiceConfig } from "./conversation-config.js";
import { recordConversationUserIntake, type ConversationIntakeContext } from "./conversation-context.js";
import type { ConversationDeliveryPlanResponse } from "./conversation-delivery-plan.js";
import {
  evaluateConversationContextProvider,
  type ConversationEvaluateDiagnostics,
  type ConversationRuntimeOptions,
} from "./conversation-evaluate-context.js";
import { createConversationStore, type ConversationStore } from "./conversation-store.js";
import {
  LEGACY_DELIVERY_CHUNK_ID,
  commitRuntimeDeliveryPlan,
  createRuntimeDeliveryPlan,
  ensureLegacyDeliveryPlan,
  type DeliveryCommitFields,
  type RuntimeCommitDeliveryResult,
} from "./conversation-runtime-delivery.js";
import {
  channelIdForScope,
  legacyDeliveryPlanId,
  scopeForEvaluateInput,
  senderRoleForAuthor,
  validCooldownMs,
} from "./conversation-runtime-support.js";
import {
  createNeutralConversationContext,
  evaluateFixation,
  evaluateHostPolicyGate,
  type HostPolicyGateAudit,
  type NeutralConversationContext,
  type RawConversationMessage,
} from "./watcher-core.js";

const WATCHER_WINDOW_N = 8;

export type WatcherRecordUserInput = {
  readonly scopeId: string;
  readonly text: string;
  readonly id?: string;
  readonly channelId?: string;
  readonly sourceThreadId?: string;
  readonly sessionId?: string;
};

export type WatcherRecordUserResult = {
  readonly ok: true;
  readonly context:
    | {
      readonly status: "disabled";
      readonly diagnostics: readonly string[];
    }
    | ConversationIntakeContext;
};

export type WatcherEvaluateInput = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly text: string;
  readonly messageId: string;
  readonly sourceThreadId?: string;
  readonly targetThreadId?: string;
  readonly sessionId?: string;
  readonly cooldownMs?: number;
  readonly privacyRisk?: boolean;
  readonly crossThreadRisk?: boolean;
  readonly deliveryMessageId?: string;
};

export type WatcherEvaluateResult = {
  readonly decision: "nudge" | "no_reply";
  readonly nudgeText?: string;
  readonly deliveryPlan?: ConversationDeliveryPlanResponse;
  readonly audit: HostPolicyGateAudit | null;
  readonly context?: NeutralConversationContext;
  readonly diagnostics?: ConversationEvaluateDiagnostics;
};

export type WatcherCommitDeliveryInput = {
  readonly cooldownKey: string;
  readonly scopeId: string;
  readonly signalId: string;
  readonly deliveryMessageId: string;
};

export class ConversationRuntime {
  private readonly store: ConversationStore;

  constructor(
    private readonly serviceDb: ServiceDatabase,
    private readonly config: ConversationServiceConfig,
    private readonly options: ConversationRuntimeOptions = {},
  ) {
    this.store = createConversationStore(serviceDb);
  }

  recordUser(input: WatcherRecordUserInput): WatcherRecordUserResult {
    if (!this.config.enabled) {
      return { ok: true, context: { status: "disabled", diagnostics: ["conversation_disabled"] } };
    }
    const now = new Date().toISOString();
    const messageId = input.id ?? this.syntheticUserMessageId(input.scopeId);
    const channelId = channelIdForScope(input.scopeId, input.channelId);
    const context = recordConversationUserIntake({
      store: this.store,
      scopeId: input.scopeId,
      channelId,
      threadId: input.sourceThreadId,
      sessionId: input.sessionId,
      messageId,
      text: input.text,
      observedAt: now,
      maxRecentEvents: WATCHER_WINDOW_N,
    });
    return { ok: true, context };
  }

  async evaluate(input: WatcherEvaluateInput): Promise<WatcherEvaluateResult> {
    if (!this.config.enabled) return { decision: "no_reply", audit: null };
    const now = new Date();
    const nowIso = now.toISOString();
    this.store.recordRawEvent({
      scopeId: input.scopeId,
      channelId: input.channelId,
      threadId: input.sourceThreadId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      authorRole: "assistant",
      authorSource: "openclaw",
      text: input.text,
      eventTs: nowIso,
      observedAt: nowIso,
      botSelfLoop: false,
    });

    const messages = this.recentMessages(input.scopeId);
    const contextProviderResult = this.options.contextProvider
      ? await evaluateConversationContextProvider({
        config: this.config,
        provider: this.options.contextProvider,
        store: this.store,
        scope: scopeForEvaluateInput(input),
        maxRecentTurns: WATCHER_WINDOW_N,
      })
      : null;
    if (contextProviderResult?.kind === "no_reply") {
      return { decision: "no_reply", audit: null, diagnostics: { context: contextProviderResult.diagnostics } };
    }

    const signal = evaluateFixation(messages, input.scopeId)[0];
    if (!signal) {
      return contextProviderResult
        ? { decision: "no_reply", audit: null, diagnostics: { context: contextProviderResult.diagnostics } }
        : { decision: "no_reply", audit: null };
    }

    const context = createNeutralConversationContext(input.scopeId, messages, nowIso);
    const cooldownMs = validCooldownMs(input.cooldownMs);
    const cooldownKey = `${input.scopeId}:${signal.fixationPattern}`;
    const gateState = this.store.getGateState(input.scopeId, cooldownKey);
    const cooldownHit = gateState ? now.getTime() - Date.parse(gateState.updatedAt) < cooldownMs : false;
    const duplicateHit = gateState?.lastSignalId === signal.signalId || this.hasCommittedSignal(input.scopeId, signal.signalId);
    const audit = evaluateHostPolicyGate({
      runtime: "openclaw",
      signal,
      criticConfidence: signal.confidence,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      sessionId: input.sessionId,
      shadowMode: false,
      cooldownHit,
      duplicateHit,
      privacyRisk: input.privacyRisk === true,
      crossThreadRisk: input.crossThreadRisk === true,
      deliveryMessageId: input.deliveryMessageId,
      now: nowIso,
    });
    const nudgeText = audit.allowed ? `방금 답변이 같은 프레임에 고정됐습니다. ${signal.suggestedPivot}` : undefined;
    const deliveryPlan = audit.allowed && nudgeText
      ? createRuntimeDeliveryPlan({
        store: this.store,
        config: this.config,
        planId: legacyDeliveryPlanId(input.scopeId, signal.signalId),
        scopeId: input.scopeId,
        channelId: input.channelId,
        signalId: signal.signalId,
        cooldownKey,
        createdAt: nowIso,
        text: nudgeText,
      })
      : undefined;

    return {
      decision: audit.allowed ? "nudge" : "no_reply",
      nudgeText,
      ...(deliveryPlan ? { deliveryPlan } : {}),
      audit,
      context,
      ...(contextProviderResult ? { diagnostics: { context: contextProviderResult.diagnostics } } : {}),
    };
  }

  commitDelivery(input: WatcherCommitDeliveryInput): void {
    const planId = legacyDeliveryPlanId(input.scopeId, input.signalId);
    const existing = this.store.getDeliveryPlan(planId);
    if (!existing) this.createMissingLegacyPlan(planId, input);
    const requiredChunkIds = existing?.requiredChunkIds.length ? existing.requiredChunkIds : [LEGACY_DELIVERY_CHUNK_ID];
    this.commitDeliveryPlan({
      planId,
      cooldownKey: input.cooldownKey,
      scopeId: input.scopeId,
      signalId: input.signalId,
      deliveryMessageIds: Object.fromEntries(requiredChunkIds.map((chunkId) => [chunkId, input.deliveryMessageId])),
    });
  }

  commitDeliveryPlan(input: DeliveryCommitFields): RuntimeCommitDeliveryResult {
    return commitRuntimeDeliveryPlan({
      store: this.store,
      config: this.config,
      now: new Date(),
      ...input,
    });
  }

  private createMissingLegacyPlan(planId: string, input: WatcherCommitDeliveryInput): void {
    ensureLegacyDeliveryPlan({
      store: this.store,
      planId,
      scopeId: input.scopeId,
      channelId: channelIdForScope(input.scopeId),
      signalId: input.signalId,
      cooldownKey: input.cooldownKey,
      createdAt: new Date().toISOString(),
    });
  }

  private recentMessages(scopeId: string): RawConversationMessage[] {
    return this.store.listRawEvents(scopeId).slice(-WATCHER_WINDOW_N).map((event) => ({
      id: event.messageId,
      senderRole: senderRoleForAuthor(event.authorRole),
      ts: event.eventTs,
      text: event.text,
      threadId: event.threadId ?? undefined,
      sessionId: event.sessionId ?? undefined,
    }));
  }

  private syntheticUserMessageId(scopeId: string): string {
    return `u-${this.store.listRawEvents(scopeId).length + 1}`;
  }

  private hasCommittedSignal(scopeId: string, signalId: string): boolean {
    const row = this.serviceDb.db.prepare(
      "SELECT 1 FROM conversation_delivery_ledger WHERE scope_id = ? AND signal_id = ? AND status = 'committed' LIMIT 1",
    ).get(scopeId, signalId);
    return row !== undefined;
  }
}

export function createConversationRuntime(
  db: ServiceDatabase,
  config: ConversationServiceConfig,
  options: ConversationRuntimeOptions = {},
): ConversationRuntime {
  return new ConversationRuntime(db, config, options);
}
