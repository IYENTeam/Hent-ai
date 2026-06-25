import type { ConversationIntakeContext } from "./conversation-context.js";

export type ConversationRecordUserInput = {
  readonly scopeId: string;
  readonly text: string;
  readonly id?: string;
  readonly channelId?: string;
  readonly sourceThreadId?: string;
  readonly sessionId?: string;
};

export type ConversationRecordUserResult = {
  readonly ok: true;
  readonly context:
    | {
      readonly status: "disabled";
      readonly diagnostics: readonly string[];
    }
    | ConversationIntakeContext;
};

export type ConversationRecordAssistantInput = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly text: string;
  readonly messageId: string;
  readonly sourceThreadId?: string;
  readonly sessionId?: string;
};
