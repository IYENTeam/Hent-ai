export type ConversationAuthorRole = "user" | "assistant" | "system";

export type ConversationRawEventInput = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly threadId?: string | null;
  readonly sessionId?: string | null;
  readonly messageId: string;
  readonly authorRole: ConversationAuthorRole;
  readonly authorSource: string;
  readonly text: string;
  readonly eventTs: string;
  readonly observedAt?: string;
  readonly botSelfLoop?: boolean;
  readonly metadata?: unknown;
};

export type ConversationRawEvent = Required<Omit<ConversationRawEventInput, "metadata" | "threadId" | "sessionId" | "observedAt" | "botSelfLoop">> & {
  readonly id: number;
  readonly threadId: string | null;
  readonly sessionId: string | null;
  readonly observedAt: string;
  readonly botSelfLoop: boolean;
  readonly metadata: unknown;
  readonly createdAt: string;
};

export type ConversationCheckpointInput = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly summary: string;
  readonly recentEventIds: readonly number[];
  readonly updatedAt: string;
};

export type ConversationCheckpoint = ConversationCheckpointInput;

export type ConversationSummaryInput = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly summary: string;
  readonly sourceEventStartId: number;
  readonly sourceEventEndId: number;
  readonly createdAt: string;
};

export type ConversationSummary = ConversationSummaryInput & {
  readonly id: number;
};

export type DeliveryPlanInput = {
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly signalId: string;
  readonly cooldownKey: string;
  readonly requiredChunkIds: readonly string[];
  readonly createdAt: string;
};

export type DeliveryPlan = DeliveryPlanInput & {
  readonly status: "planned" | "committed";
  readonly deliveryMessageIds: Readonly<Record<string, string>>;
  readonly committedAt: string | null;
};

export type CommitDeliveryInput = {
  readonly planId: string;
  readonly deliveryMessageIds: Readonly<Record<string, string>>;
  readonly committedAt: string;
  readonly cooldownUntil?: string;
  readonly budgetWindowStart?: string;
  readonly budgetCount?: number;
};

export type CommitDeliveryResult =
  | { readonly status: "committed"; readonly plan: DeliveryPlan }
  | { readonly status: "idempotent"; readonly plan: DeliveryPlan }
  | { readonly status: "missing_required_chunks"; readonly missingChunkIds: readonly string[] }
  | { readonly status: "conflict"; readonly plan: DeliveryPlan };

export type ConversationGateState = {
  readonly scopeId: string;
  readonly stateKey: string;
  readonly cooldownUntil: string | null;
  readonly budgetWindowStart: string | null;
  readonly budgetCount: number;
  readonly lastSignalId: string | null;
  readonly updatedAt: string;
};

export type RawRetentionInput = {
  readonly retentionDays: number;
  readonly now: string;
};
