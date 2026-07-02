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

export type RawRetentionInput = {
  readonly retentionDays: number;
  readonly now: string;
};
