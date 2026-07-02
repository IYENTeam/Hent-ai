import type { ConversationChatReplyResult } from "./conversation-chat-reply.js";
import { DEFAULT_CONVERSATION_CONFIG, type ConversationServiceConfig } from "./conversation-config.js";
import { delayForChunkByLength } from "./conversation-delivery-timing.js";
import type { ConversationRuntime } from "./conversation-runtime.js";
import {
  DiscordHttpError,
  RateLimitError,
  createDiscordRestClient,
  createDiscordRestPoller,
  type DiscordPollerStateStore,
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
  readonly pollerStateStore?: DiscordPollerStateStore;
  readonly conversationConfig?: ConversationServiceConfig;
  readonly log?: DiscordPollerLog;
  readonly wait?: (ms: number) => Promise<void>;
  readonly random?: () => number;
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
  readonly deliveryAttempts: number;
};

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_EVALUATION_INTERVAL_MS = 60_000;

export function createDiscordPollerIntegration(options: DiscordPollerIntegrationOptions): DiscordPollerIntegration {
  const log = options.log ?? (() => {});
  const wait = options.wait ?? defaultWait;
  const random = options.random ?? Math.random;
  const conversationConfig = options.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const maxDeliveryAttempts = positiveInteger(conversationConfig.maxDeliveryAttempts, DEFAULT_CONVERSATION_CONFIG.maxDeliveryAttempts);
  const client = options.client ?? createDiscordRestClient(options.config.token);
  const pendingChatReplies = new Map<string, PendingChatReply>();
  let replyTimer: ReturnType<typeof setInterval> | null = null;
  let activeReplyCheck: Promise<void> | null = null;
  const poller = createDiscordRestPoller({
    config: options.config,
    client,
    stateStore: options.pollerStateStore,
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
      try {
        const result = await options.runtime.evaluateChatReply(pendingReply);
        const delivered = await deliverChatReply({
          result,
          runtime: options.runtime,
          channelId: pendingReply.channelId,
          scopeId: pendingReply.scopeId,
          messageId: pendingReply.messageId,
          conversationConfig,
          client,
          pendingChatReplies,
          log,
          wait,
          random,
        });
        const latest = pendingChatReplies.get(pendingReply.channelId);
        if (delivered === "delivered" && latest?.messageId === pendingReply.messageId) {
          pendingChatReplies.delete(pendingReply.channelId);
        } else if (delivered === "discarded" && latest?.messageId === pendingReply.messageId) {
          pendingChatReplies.delete(pendingReply.channelId);
        } else if (delivered === "failed") {
          recordFailedDeliveryAttempt(pendingChatReplies, pendingReply, maxDeliveryAttempts, log);
        }
      } catch (error) {
        log("error", `discord-poller-integration: reply check failed channel=${pendingReply.channelId}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    ?? stringEnv(env.DISCORD_BOT_TOKEN);
  const channels = channelListEnv(env.HENT_AI_DISCORD_POLLER_CHANNELS);
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
    deliveryAttempts: 0,
  });
}

type DeliveryOutcome = "delivered" | "deferred" | "failed" | "discarded";

async function deliverChatReply(input: {
  readonly result: ConversationChatReplyResult;
  readonly runtime: ConversationRuntime;
  readonly channelId: string;
  readonly scopeId: string;
  readonly messageId: string;
  readonly conversationConfig: ConversationServiceConfig;
  readonly client?: DiscordRestClient;
  readonly pendingChatReplies: Map<string, PendingChatReply>;
  readonly log: DiscordPollerLog;
  readonly wait: (ms: number) => Promise<void>;
  readonly random: () => number;
}): Promise<DeliveryOutcome> {
  if (input.result.decision === "no_reply") {
    input.log("info", `discord-poller-integration: chat reply skipped reason=${input.result.reason}`);
    return "deferred";
  }
  if (!input.client) {
    input.log("warn", "discord-poller-integration: no Discord client for chat reply");
    return "failed";
  }
  for (const chunk of input.result.chunks) {
    if (!isCurrentPending(input.pendingChatReplies, input.channelId, input.messageId)) return "deferred";
    const delayMs = delayForChunkByLength(chunk, input.conversationConfig, input.random);
    await triggerTypingDuringDelay(input.client, input.channelId, delayMs, input.wait, input.log);
    if (!isCurrentPending(input.pendingChatReplies, input.channelId, input.messageId)) return "deferred";
    const sendOutcome = await sendMessageWithRetry(input.client, input.channelId, chunk, input.wait, input.log);
    if (sendOutcome.kind === "discarded") return "discarded";
    if (sendOutcome.kind === "failed") return "failed";
    input.runtime.recordAssistant({ scopeId: input.scopeId, channelId: input.channelId, text: chunk, messageId: sendOutcome.sentId });
  }
  input.log("info", `discord-poller-integration: delivered chat reply chunks=${input.result.chunks.length}`);
  return "delivered";
}

function isCurrentPending(pendingChatReplies: Map<string, PendingChatReply>, channelId: string, messageId: string): boolean {
  return pendingChatReplies.get(channelId)?.messageId === messageId;
}

function recordFailedDeliveryAttempt(
  pendingChatReplies: Map<string, PendingChatReply>,
  pendingReply: PendingChatReply,
  maxDeliveryAttempts: number,
  log: DiscordPollerLog,
): void {
  const current = pendingChatReplies.get(pendingReply.channelId);
  if (!current || current.messageId !== pendingReply.messageId) return;
  const deliveryAttempts = current.deliveryAttempts + 1;
  if (deliveryAttempts >= maxDeliveryAttempts) {
    pendingChatReplies.delete(pendingReply.channelId);
    log("error", `discord-poller-integration: dropping failed chat reply channel=${pendingReply.channelId} attempts=${deliveryAttempts}`);
    return;
  }
  pendingChatReplies.set(pendingReply.channelId, { ...current, deliveryAttempts });
  log("warn", `discord-poller-integration: retaining failed chat reply channel=${pendingReply.channelId} attempts=${deliveryAttempts}`);
}

async function triggerTypingDuringDelay(
  client: DiscordRestClient,
  channelId: string,
  delayMs: number,
  wait: (ms: number) => Promise<void>,
  log: DiscordPollerLog,
): Promise<void> {
  await triggerTyping(client, channelId, log);
  let remainingMs = delayMs;
  while (remainingMs > 9_000) {
    await wait(9_000);
    remainingMs -= 9_000;
    await triggerTyping(client, channelId, log);
  }
  await wait(remainingMs);
}

async function triggerTyping(client: DiscordRestClient, channelId: string, log: DiscordPollerLog): Promise<void> {
  try {
    await client.triggerTyping?.(channelId);
  } catch (error) {
    log("warn", `discord-poller-integration: typing failed channel=${channelId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sendMessageWithRetry(
  client: DiscordRestClient,
  channelId: string,
  chunk: string,
  wait: (ms: number) => Promise<void>,
  log: DiscordPollerLog,
): Promise<{ readonly kind: "sent"; readonly sentId: string } | { readonly kind: "failed" } | { readonly kind: "discarded" }> {
  try {
    const sentId = await client.sendMessage(channelId, chunk);
    return sentId ? { kind: "sent", sentId } : { kind: "failed" };
  } catch (error) {
    if (isDiscardableDiscordSendError(error)) {
      log("error", `discord-poller-integration: discarding chat reply channel=${channelId} status=${error.status}`);
      return { kind: "discarded" };
    }
    if (!(error instanceof RateLimitError)) {
      log("error", `discord-poller-integration: send failed channel=${channelId}: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: "failed" };
    }
    log("warn", `discord-poller-integration: send rate limited channel=${channelId} retryAfterMs=${error.retryAfterMs}`);
    await wait(error.retryAfterMs);
    try {
      const sentId = await client.sendMessage(channelId, chunk);
      return sentId ? { kind: "sent", sentId } : { kind: "failed" };
    } catch (retryError) {
      if (isDiscardableDiscordSendError(retryError)) {
        log("error", `discord-poller-integration: discarding chat reply channel=${channelId} status=${retryError.status}`);
        return { kind: "discarded" };
      }
      log("error", `discord-poller-integration: send retry failed channel=${channelId}: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      return { kind: "failed" };
    }
  }
}

function isDiscardableDiscordSendError(error: unknown): error is DiscordHttpError {
  return error instanceof DiscordHttpError && (error.status === 403 || error.status === 404);
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
