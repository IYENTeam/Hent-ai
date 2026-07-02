import type { ServiceDatabase } from "./db.js";
import type { ConversationScope, ConversationServiceConfig } from "./conversation-config.js";
import {
  evaluateConversationChatReply,
  type ConversationChatReplyInput,
  type ConversationChatReplyResult,
} from "./conversation-chat-reply.js";
import type { ConversationContextRefreshResult } from "./conversation-context-refresher.js";
import { recordConversationUserIntake } from "./conversation-context.js";
import type { ConversationRecordAssistantInput, ConversationRecordUserInput, ConversationRecordUserResult } from "./conversation-recording.js";
import { createConversationStore, type ConversationStore } from "./conversation-store.js";
import type { ConversationDecisionProvider } from "./conversation-config.js";

export type { ConversationRecordAssistantInput, ConversationRecordUserInput, ConversationRecordUserResult } from "./conversation-recording.js";

export type ConversationRuntimeOptions = {
  readonly decisionProvider?: ConversationDecisionProvider;
  readonly refreshContext?: (scope: ConversationScope) => Promise<ConversationContextRefreshResult>;
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
      maxRecentEvents: this.config.recentTurnWindow,
    });
    return { ok: true, context };
  }

  recordAssistant(input: ConversationRecordAssistantInput): void {
    if (!this.config.enabled) return;
    this.recordAssistantEvent(input, new Date());
  }

  async evaluateChatReply(input: ConversationChatReplyInput): Promise<ConversationChatReplyResult> {
    if (this.options.refreshContext && this.config.contextRefreshEnabled) {
      await this.options.refreshContext({ scopeId: input.scopeId, channelId: input.channelId });
    }
    return evaluateConversationChatReply({
      config: this.config,
      store: this.store,
      decisionProvider: this.options.decisionProvider,
      resolveChannelPolicy: (channelId) => this.resolveChannelPolicy(channelId),
      scope: input,
      maxRecentTurns: this.config.recentTurnWindow,
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

  private resolveChannelPolicy(channelId: string): {
    readonly enabled: boolean | null;
    readonly profile?: { readonly soulSnippet: string | null } | undefined;
  } {
    const mapping = this.serviceDb.getChannelMapping(channelId);
    const enabled = mapping?.enabled ?? this.config.defaultChannelEnabled;
    const profile = mapping?.profileId ? this.serviceDb.getProfile(mapping.profileId) : null;
    return {
      enabled,
      ...(profile ? { profile: { soulSnippet: profile.soulSnippet } } : {}),
    };
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
