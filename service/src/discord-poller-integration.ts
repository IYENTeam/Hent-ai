/**
 * Integrates the Discord REST poller with the Hent-ai conversation runtime.
 *
 * Bridges discord-rest-poller (fetch/send) ↔ ConversationRuntime (record/evaluate).
 * The poller feeds user messages into the runtime for evaluation, and when the
 * runtime decides to speak, sends the response back via Discord REST.
 */

import {
  createDiscordRestPoller,
  type DiscordRestMessage,
  type DiscordRestPollerConfig,
} from "./discord-rest-poller.js";
import type { ConversationRuntime } from "./conversation-runtime.js";

export type DiscordPollerIntegrationConfig = DiscordRestPollerConfig & {
  /** If true, poller starts automatically. Default: true when configured via env. */
  readonly autoStart?: boolean;
};

export type DiscordPollerIntegrationOptions = {
  readonly config: DiscordPollerIntegrationConfig;
  readonly runtime: ConversationRuntime;
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
};

export function createDiscordPollerIntegration(options: DiscordPollerIntegrationOptions) {
  const { config, runtime, log } = options;

  async function handleMessage(
    channelId: string,
    message: DiscordRestMessage,
  ): Promise<{ speak: true; text: string } | { speak: false }> {
    const scopeId = `discord:${channelId}`;

    // Record the user message into the conversation runtime
    runtime.recordUser({
      scopeId,
      text: message.content,
      id: message.id,
      channelId,
    });

    // Evaluate whether we should respond
    const result = await runtime.evaluate({
      scopeId,
      channelId,
      text: message.content,
      messageId: message.id,
    });

    if (result.decision === "nudge" && result.nudgeText) {
      return { speak: true, text: result.nudgeText };
    }

    // Check if the delivery plan has chunks to send
    if (result.deliveryPlan?.chunks && result.deliveryPlan.chunks.length > 0) {
      const combinedText = result.deliveryPlan.chunks
        .map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? ""))
        .filter(Boolean)
        .join("\n");
      if (combinedText) {
        return { speak: true, text: combinedText };
      }
    }

    return { speak: false };
  }

  const poller = createDiscordRestPoller({
    config,
    callbacks: {
      log,
      onMessages: (channelId, messages) => {
        log?.("info", `poller-integration: received ${messages.length} new messages from channel=${channelId}`);
      },
      onSpeak: (channelId, text, messageId) => {
        log?.("info", `poller-integration: spoke in channel=${channelId} msgId=${messageId ?? "unknown"}: ${text.slice(0, 80)}`);
      },
    },
    handleMessage,
  });

  if (config.autoStart) {
    poller.start();
  }

  return {
    poller,
    start: () => poller.start(),
    stop: () => poller.stop(),
  };
}

/**
 * Load poller config from environment variables.
 * Returns null if HENT_AI_DISCORD_POLLER_CHANNELS is not set.
 */
export function loadDiscordPollerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DiscordPollerIntegrationConfig | null {
  const token = env.HENT_AI_DISCORD_POLLER_TOKEN ?? env.DISCORD_BOT_TOKEN;
  const channelsRaw = env.HENT_AI_DISCORD_POLLER_CHANNELS;
  if (!token || !channelsRaw) return null;

  const channels = channelsRaw.split(",").map((c) => c.trim()).filter(Boolean);
  if (channels.length === 0) return null;

  const intervalMs = env.HENT_AI_DISCORD_POLLER_INTERVAL_MS
    ? parseInt(env.HENT_AI_DISCORD_POLLER_INTERVAL_MS, 10)
    : 15_000;

  const botUserId = env.HENT_AI_DISCORD_POLLER_BOT_USER_ID;

  return {
    token,
    channels,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15_000,
    botUserId,
    autoStart: env.HENT_AI_DISCORD_POLLER_AUTO_START !== "false",
  };
}
