import type { ConversationIntakeContext } from "./conversation-context.js";
import type { ConversationDeliveryPlanResponse } from "./conversation-delivery-plan.js";
import type { ConversationEvaluateDiagnostics } from "./conversation-evaluate-context.js";
import type { HostPolicyGateAudit, NeutralConversationContext } from "./watcher-core.js";

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

export type WatcherRecordAssistantInput = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly text: string;
  readonly messageId: string;
  readonly sourceThreadId?: string;
  readonly sessionId?: string;
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
