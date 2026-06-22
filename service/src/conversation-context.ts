import type { ConversationRawEvent, ConversationStore } from "./conversation-store.js";

export type ConversationIntakeContext = {
  readonly status: "updated";
  readonly scopeId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly sessionId?: string;
  readonly recentEventCount: number;
  readonly checkpointEventIds: readonly number[];
  readonly summary: string;
};

export type ConversationIntakeInput = {
  readonly store: ConversationStore;
  readonly scopeId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly sessionId?: string;
  readonly messageId: string;
  readonly text: string;
  readonly observedAt: string;
  readonly maxRecentEvents: number;
};

export function recordConversationUserIntake(input: ConversationIntakeInput): ConversationIntakeContext {
  input.store.recordRawEvent({
    scopeId: input.scopeId,
    channelId: input.channelId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    authorRole: "user",
    authorSource: "openclaw",
    text: input.text,
    eventTs: input.observedAt,
    observedAt: input.observedAt,
    botSelfLoop: false,
  });
  const recentEvents = input.store.listRawEvents(input.scopeId).slice(-input.maxRecentEvents);
  const checkpointEventIds = recentEvents.map((event) => event.id);
  const summary = summarizeRecentEvents(recentEvents);
  input.store.upsertCheckpoint({
    scopeId: input.scopeId,
    channelId: input.channelId,
    summary,
    recentEventIds: checkpointEventIds,
    updatedAt: input.observedAt,
  });
  return {
    status: "updated",
    scopeId: input.scopeId,
    channelId: input.channelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    recentEventCount: recentEvents.length,
    checkpointEventIds,
    summary,
  };
}

function summarizeRecentEvents(events: readonly ConversationRawEvent[]): string {
  const turns = events.map((event) => `${event.authorRole}: ${event.text}`).join(" | ");
  return `Recent room context: ${turns}`;
}
