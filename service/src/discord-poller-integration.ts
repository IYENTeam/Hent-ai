import type { ConversationChatReplyResult } from "./conversation-chat-reply.js";
import type { ConversationRuntime } from "./conversation-runtime.js";
import {
  createDiscordRestClient,
  createDiscordRestPoller,
  type DiscordRestClient,
  type DiscordRestMessage,
  type DiscordRestPoller,
  type DiscordRestPollerConfig,
} from "./discord-rest-poller.js";

export type DiscordPollerIntegrationConfig = DiscordRestPollerConfig & {
  readonly autoStart?: boolean;
  readonly evaluationIntervalMs?: number;
};

export type DiscordPollerLog = (level: "info" | "warn" | "error", message: string) => void;

export type DiscordPollerIntegrationOptions = {
  readonly config: DiscordPollerIntegrationConfig;
  readonly runtime: ConversationRuntime;
  readonly client?: DiscordRestClient;
  readonly log?: DiscordPollerLog;
  readonly wait?: (ms: number) => Promise<void>;
};

export type DiscordPollerIntegration = {
  readonly poller: DiscordRestPoller;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly evaluateOnce: () => Promise<void>;
};

type PendingChatReply = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly messageId: string;
};

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_EVALUATION_INTERVAL_MS = 60_000;

export function createDiscordPollerIntegration(options: DiscordPollerIntegrationOptions): DiscordPollerIntegration {
  const log = options.log ?? (() => {});
  const wait = options.wait ?? defaultWait;
  const client = options.client ?? createDiscordRestClient(options.config.token);
  const pendingChatReplies = new Map<string, PendingChatReply>();
  let replyTimer: ReturnType<typeof setInterval> | null = null;
  let activeReplyCheck: Promise<void> | null = null;
  const poller = createDiscordRestPoller({
    config: options.config,
    client,
    callbacks: {
      log,
      onMessages: (channelId, messages) => {
        log("info", `discord-poller-integration: observed channel=${channelId} messages=${messages.length}`);
      },
    },
    onMessage: (message) => handleDiscordMessage({ message, runtime: options.runtime, config: options.config, log, pendingChatReplies }),
  });

  async function runReplyCheck(): Promise<void> {
    for (const pendingReply of pendingChatReplies.values()) {
      const result = await options.runtime.evaluateChatReply(pendingReply);
      const current = pendingChatReplies.get(pendingReply.channelId);
      const delivered = await deliverChatReply({ result, runtime: options.runtime, channelId: pendingReply.channelId, scopeId: pendingReply.scopeId, client, log, wait });
      if (delivered && current?.messageId === pendingReply.messageId) pendingChatReplies.delete(pendingReply.channelId);
    }
  }

  async function evaluateOnce(): Promise<void> {
    if (activeReplyCheck) return activeReplyCheck;
    activeReplyCheck = runReplyCheck();
    try {
      await activeReplyCheck;
    } finally {
      activeReplyCheck = null;
    }
  }

  function startReplyTimer(): void {
    if (replyTimer) return;
    replyTimer = setInterval(() => void evaluateOnce(), positiveInteger(options.config.evaluationIntervalMs, DEFAULT_EVALUATION_INTERVAL_MS));
  }

  const integration = {
    poller,
    start() {
      poller.start();
      startReplyTimer();
    },
    async stop() {
      if (replyTimer) {
        clearInterval(replyTimer);
        replyTimer = null;
      }
      await poller.stop();
      if (activeReplyCheck) await activeReplyCheck;
    },
    evaluateOnce,
  };

  if (options.config.autoStart === true) integration.start();

  return integration;
}

export function loadDiscordPollerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DiscordPollerIntegrationConfig | null {
  const token = stringEnv(env.HENT_AI_DISCORD_POLLER_TOKEN)
    ?? stringEnv(env.DISCORD_BOT_TOKEN)
    ?? stringEnv(env.HENT_AI_DISCORD_TOKEN);
  const channels = channelListEnv(stringEnv(env.HENT_AI_DISCORD_POLLER_CHANNELS) ?? stringEnv(env.HENT_AI_WATCH_CHANNELS));
  if (!token || channels.length === 0) return null;

  return {
    token,
    channels,
    intervalMs: positiveIntegerEnv(env.HENT_AI_DISCORD_POLLER_INTERVAL_MS),
    evaluationIntervalMs: positiveIntegerEnv(env.HENT_AI_DISCORD_POLLER_EVALUATION_INTERVAL_MS),
    limit: positiveIntegerEnv(env.HENT_AI_DISCORD_POLLER_LIMIT),
    botUserId: stringEnv(env.HENT_AI_DISCORD_POLLER_BOT_USER_ID),
    autoStart: env.HENT_AI_DISCORD_POLLER_AUTO_START !== "false",
  };
}

async function handleDiscordMessage(input: {
  readonly message: DiscordRestMessage;
  readonly runtime: ConversationRuntime;
  readonly config: DiscordPollerIntegrationConfig;
  readonly log: DiscordPollerLog;
  readonly pendingChatReplies: Map<string, PendingChatReply>;
}): Promise<void> {
  const scopeId = `discord:${input.message.channelId}`;
  if (isSelfBotMessage(input.message, input.config.botUserId)) {
    input.runtime.recordAssistant({
      scopeId,
      channelId: input.message.channelId,
      text: input.message.content,
      messageId: input.message.id,
    });
    return;
  }
  if (input.message.authorBot) {
    input.log("info", `discord-poller-integration: skipped non-self bot message=${input.message.id}`);
    return;
  }
  input.runtime.recordUser({
    scopeId,
    channelId: input.message.channelId,
    text: input.message.content,
    id: input.message.id,
  });
  input.pendingChatReplies.set(input.message.channelId, {
    scopeId,
    channelId: input.message.channelId,
    messageId: input.message.id,
  });
}

async function deliverChatReply(input: {
  readonly result: ConversationChatReplyResult;
  readonly runtime: ConversationRuntime;
  readonly channelId: string;
  readonly scopeId: string;
  readonly client?: DiscordRestClient;
  readonly log: DiscordPollerLog;
  readonly wait: (ms: number) => Promise<void>;
}): Promise<boolean> {
  if (input.result.decision === "no_reply") {
    input.log("info", `discord-poller-integration: chat reply skipped reason=${input.result.reason}`);
    return false;
  }
  if (!input.client) {
    input.log("warn", "discord-poller-integration: no Discord client for chat reply");
    return false;
  }
  for (const chunk of input.result.chunks) {
    const sentId = await input.client.sendMessage(input.channelId, chunk);
    if (sentId) input.runtime.recordAssistant({ scopeId: input.scopeId, channelId: input.channelId, text: chunk, messageId: sentId });
    await input.wait(0);
  }
  input.log("info", `discord-poller-integration: delivered chat reply chunks=${input.result.chunks.length}`);
  return true;
}

function isSelfBotMessage(message: DiscordRestMessage, botUserId: string | undefined): boolean {
  return Boolean(botUserId) && message.authorId === botUserId;
}

function stringEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function channelListEnv(value: string | undefined): readonly string[] {
  return stringEnv(value)?.split(",").map((channel) => channel.trim()).filter(Boolean) ?? [];
}

function positiveIntegerEnv(value: string | undefined): number | undefined {
  const normalized = stringEnv(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
