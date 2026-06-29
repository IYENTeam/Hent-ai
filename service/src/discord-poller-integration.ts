import type { ConversationDeliveryPlanResponse } from "./conversation-delivery-plan.js";
import type { ConversationRuntime, WatcherEvaluateResult } from "./conversation-runtime.js";
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

type PendingEvaluation = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly text: string;
  readonly messageId: string;
};

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_EVALUATION_INTERVAL_MS = 60_000;

export function createDiscordPollerIntegration(options: DiscordPollerIntegrationOptions): DiscordPollerIntegration {
  const log = options.log ?? (() => {});
  const wait = options.wait ?? defaultWait;
  const client = options.client ?? createDiscordRestClient(options.config.token);
  const pendingEvaluations = new Map<string, PendingEvaluation>();
  let evaluationTimer: ReturnType<typeof setInterval> | null = null;
  let activeEvaluation: Promise<void> | null = null;
  const poller = createDiscordRestPoller({
    config: options.config,
    client,
    callbacks: {
      log,
      onMessages: (channelId, messages) => {
        log("info", `discord-poller-integration: observed channel=${channelId} messages=${messages.length}`);
      },
    },
    onMessage: (message) => handleDiscordMessage({ message, runtime: options.runtime, config: options.config, log, pendingEvaluations }),
  });

  async function runEvaluation(): Promise<void> {
    for (const evaluation of Array.from(pendingEvaluations.values())) {
      const result = await options.runtime.evaluate(evaluation);
      const current = pendingEvaluations.get(evaluation.messageId);
      if (current?.messageId === evaluation.messageId) pendingEvaluations.delete(evaluation.messageId);
      await deliverEvaluationResult({ result, runtime: options.runtime, client, log, wait });
    }
  }

  async function evaluateOnce(): Promise<void> {
    if (activeEvaluation) return activeEvaluation;
    activeEvaluation = runEvaluation();
    try {
      await activeEvaluation;
    } finally {
      activeEvaluation = null;
    }
  }

  function startEvaluationTimer(): void {
    if (evaluationTimer) return;
    evaluationTimer = setInterval(() => void evaluateOnce(), positiveInteger(options.config.evaluationIntervalMs, DEFAULT_EVALUATION_INTERVAL_MS));
  }

  const integration = {
    poller,
    start() {
      poller.start();
      startEvaluationTimer();
    },
    async stop() {
      if (evaluationTimer) {
        clearInterval(evaluationTimer);
        evaluationTimer = null;
      }
      await poller.stop();
      if (activeEvaluation) await activeEvaluation;
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
  readonly pendingEvaluations: Map<string, PendingEvaluation>;
}): Promise<void> {
  const scopeId = `discord:${input.message.channelId}`;
  if (isSelfBotMessage(input.message, input.config.botUserId)) {
    const evaluation = {
      scopeId,
      channelId: input.message.channelId,
      text: input.message.content,
      messageId: input.message.id,
    };
    input.runtime.recordAssistant(evaluation);
    input.pendingEvaluations.set(input.message.id, evaluation);
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
}

async function deliverEvaluationResult(input: {
  readonly result: WatcherEvaluateResult;
  readonly runtime: ConversationRuntime;
  readonly client?: DiscordRestClient;
  readonly log: DiscordPollerLog;
  readonly wait: (ms: number) => Promise<void>;
}): Promise<void> {
  if (input.result.deliveryPlan) {
    await deliverPlan({ plan: input.result.deliveryPlan, runtime: input.runtime, client: input.client, log: input.log, wait: input.wait });
    return;
  }
  if (input.result.nudgeText && input.result.audit?.allowed) {
    input.log("warn", "discord-poller-integration: evaluation returned legacy nudge without delivery plan");
  }
}

async function deliverPlan(input: {
  readonly plan: ConversationDeliveryPlanResponse;
  readonly runtime: ConversationRuntime;
  readonly client?: DiscordRestClient;
  readonly log: DiscordPollerLog;
  readonly wait: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!input.client) {
    input.log("warn", `discord-poller-integration: no Discord client for plan=${input.plan.planId}`);
    return;
  }
  const requiredChunkIds = new Set(input.plan.commit.requiredChunkIds);
  const deliveryMessageIds: Record<string, string> = {};
  for (const chunk of input.plan.chunks) {
    await input.wait(chunk.delayMs);
    const sentId = await input.client.sendMessage(input.plan.channelId, chunk.text);
    if (sentId && requiredChunkIds.has(chunk.chunkId)) deliveryMessageIds[chunk.chunkId] = sentId;
  }
  if (!input.plan.commit.requiredChunkIds.every((chunkId) => deliveryMessageIds[chunkId])) {
    input.log("warn", `discord-poller-integration: incomplete delivery for plan=${input.plan.planId}`);
    return;
  }
  const commit = input.runtime.commitDeliveryPlan({
    planId: input.plan.commit.planId,
    cooldownKey: input.plan.commit.cooldownKey,
    scopeId: input.plan.scopeId,
    signalId: input.plan.commit.signalId,
    deliveryMessageIds,
  });
  input.log("info", `discord-poller-integration: committed plan=${input.plan.planId} status=${commit.status}`);
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
