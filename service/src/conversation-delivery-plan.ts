import type { ConversationServiceConfig } from "./conversation-config.js";

export type ConversationDeliveryChunkMetadata = {
  readonly hentAiConversationChunk: true;
  readonly planId: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
};

export type ConversationDeliveryChunk = {
  readonly chunkId: string;
  readonly text: string;
  readonly delayMs: number;
  readonly metadata: ConversationDeliveryChunkMetadata;
};

export type ConversationDeliveryPlanResponse = {
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly chunks: readonly ConversationDeliveryChunk[];
  readonly commit: {
    readonly planId: string;
    readonly cooldownKey: string;
    readonly signalId: string;
    readonly requiredChunkIds: readonly string[];
  };
};

export type DeliveryPlanBuildInput = {
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly signalId: string;
  readonly cooldownKey: string;
  readonly text: string;
  readonly config: ConversationServiceConfig;
};

const HARD_MAX_CHUNKS = 4;
const HARD_MAX_CHARS = 1_800;

export function buildConversationDeliveryPlan(input: DeliveryPlanBuildInput): ConversationDeliveryPlanResponse {
  const texts = splitDeliveryText(input.text, input.config);
  const chunks = texts.map((text, index) => {
    const chunkId = `${input.planId}:chunk-${index + 1}`;
    const metadata: ConversationDeliveryChunkMetadata = {
      hentAiConversationChunk: true,
      planId: input.planId,
      chunkIndex: index,
      chunkCount: texts.length,
    };
    return {
      chunkId,
      text,
      delayMs: delayForChunk(index, texts.length, input.config),
      metadata,
    };
  });
  return {
    planId: input.planId,
    scopeId: input.scopeId,
    channelId: input.channelId,
    chunks,
    commit: {
      planId: input.planId,
      cooldownKey: input.cooldownKey,
      signalId: input.signalId,
      requiredChunkIds: chunks.map((chunk) => chunk.chunkId),
    },
  };
}

function splitDeliveryText(text: string, config: ConversationServiceConfig): readonly string[] {
  const maxChars = Math.min(Math.max(1, config.maxChunkChars), HARD_MAX_CHARS);
  const maxChunks = Math.min(Math.max(1, config.maxChunks), HARD_MAX_CHUNKS);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0 && chunks.length < maxChunks) {
    const next = takeChunk(remaining, maxChars);
    chunks.push(next.text);
    remaining = next.remaining;
  }
  return chunks;
}

function takeChunk(text: string, maxChars: number): { readonly text: string; readonly remaining: string } {
  if (text.length <= maxChars) return { text, remaining: "" };
  const candidate = text.slice(0, maxChars + 1);
  const lastSpace = candidate.lastIndexOf(" ");
  const splitAt = lastSpace > 0 ? lastSpace : maxChars;
  return {
    text: text.slice(0, splitAt).trim(),
    remaining: text.slice(splitAt).trim(),
  };
}

function delayForChunk(index: number, count: number, config: ConversationServiceConfig): number {
  const minDelay = Math.min(config.minDelayMs, config.maxDelayMs);
  const maxDelay = Math.max(config.minDelayMs, config.maxDelayMs);
  if (count <= 1 || minDelay === maxDelay) return minDelay;
  const step = Math.floor((maxDelay - minDelay) / Math.max(1, count - 1));
  return Math.min(maxDelay, minDelay + step * index);
}
