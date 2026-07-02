import type { ConversationServiceConfig } from "./conversation-config.js";

const HARD_MAX_CHUNKS = 8;
const HARD_MAX_CHARS = 1_800;
const JITTER_MIN = 0.85;
const JITTER_MAX = 1.2;

export function delayForChunkByLength(
  chunkText: string,
  config: ConversationServiceConfig,
  random: () => number = Math.random,
): number {
  const minDelay = Math.min(config.minDelayMs, config.maxDelayMs);
  const maxDelay = Math.max(config.minDelayMs, config.maxDelayMs);
  const jitter = JITTER_MIN + clamp01(random()) * (JITTER_MAX - JITTER_MIN);
  const calculated = Math.round((config.basePauseMs + config.perCharMs * chunkText.length) * jitter);
  return clamp(minDelay, calculated, maxDelay);
}

export function splitDeliveryChunks(chunks: readonly string[], config: ConversationServiceConfig): readonly string[] {
  const maxChars = Math.min(Math.max(1, config.maxChunkChars), HARD_MAX_CHARS);
  const maxChunks = Math.min(Math.max(1, config.maxChunks), HARD_MAX_CHUNKS);
  const normalized: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    for (const split of splitOneChunk(trimmed, maxChars)) {
      if (normalized.length >= maxChunks) return normalized;
      normalized.push(split);
    }
  }
  return normalized;
}

function splitOneChunk(text: string, maxChars: number): readonly string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    const candidate = remaining.slice(0, maxChars + 1);
    const punctuationAt = Math.max(candidate.lastIndexOf("."), candidate.lastIndexOf("!"), candidate.lastIndexOf("?"), candidate.lastIndexOf("。"));
    const spaceAt = candidate.lastIndexOf(" ");
    const splitAt = punctuationAt > 0 ? punctuationAt + 1 : spaceAt > 0 ? spaceAt : maxChars;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(0, value, 1);
}
