import type { ServiceDatabase } from "./db.js";
import type { ConversationServiceConfig } from "./conversation-config.js";
import {
  evaluateConversationChatReply,
  type ConversationChatReplyInput,
  type ConversationChatReplyResult,
} from "./conversation-chat-reply.js";
import { recordConversationUserIntake } from "./conversation-context.js";
import type { ConversationRecordAssistantInput, ConversationRecordUserInput, ConversationRecordUserResult } from "./conversation-recording.js";
import { createConversationStore, type ConversationStore } from "./conversation-store.js";
import type { ConversationDecisionProvider } from "./conversation-config.js";

const RECENT_TURN_WINDOW_SIZE = 8;

export type { ConversationRecordAssistantInput, ConversationRecordUserInput, ConversationRecordUserResult } from "./conversation-recording.js";

export type ConversationRuntimeOptions = {
  readonly decisionProvider?: ConversationDecisionProvider;
};

export class ConversationRuntime {
  private readonly store: ConversationStore;

  constructor(
    serviceDb: ServiceDatabase,
    private readonly config: ConversationServiceConfig,
    private readonly options: ConversationRuntimeOptions = {},
  ) {
    this.store = createConversationStore(serviceDb);
  }

  recordUser(input: ConversationRecordUserInput): ConversationRecordUserResult {
    if (!this.config.enabled) {
      return { ok: true, context: { status: "disabled", diagnostics: ["conversation_disabled"] } };
    }
    const now = new Date().toISOString();
    const messageId = input.id ?? this.syntheticUserMessageId(input.scopeId);
    const channelId = input.channelId ?? channelIdForScope(input.scopeId);
    const context = recordConversationUserIntake({
      store: this.store,
      scopeId: input.scopeId,
      channelId,
      threadId: input.sourceThreadId,
      sessionId: input.sessionId,
      messageId,
      text: input.text,
      observedAt: now,
      maxRecentEvents: RECENT_TURN_WINDOW_SIZE,
    });
    return { ok: true, context };
  }

  recordAssistant(input: ConversationRecordAssistantInput): void {
    if (!this.config.enabled) return;
    this.recordAssistantEvent(input, new Date());
  }

  async evaluateChatReply(input: ConversationChatReplyInput): Promise<ConversationChatReplyResult> {
    return evaluateConversationChatReply({
      config: this.config,
      store: this.store,
      decisionProvider: this.options.decisionProvider,
      scope: input,
      maxRecentTurns: RECENT_TURN_WINDOW_SIZE,
      nowMs: Date.now(),
    });
  }

  private recordAssistantEvent(input: ConversationRecordAssistantInput, now: Date): void {
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
  }

  private syntheticUserMessageId(scopeId: string): string {
    return `u-${this.store.listRawEvents(scopeId).length + 1}`;
  }
}

function channelIdForScope(scopeId: string): string {
  const match = /^channel:([^:]+)/.exec(scopeId);
  return match?.[1] ?? scopeId;
}

export function createConversationRuntime(
  db: ServiceDatabase,
  config: ConversationServiceConfig,
  options: ConversationRuntimeOptions = {},
): ConversationRuntime {
  return new ConversationRuntime(db, config, options);
}
