import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAdaptiveBatch, type AdaptiveBatchEvent } from "./adaptive-batch.js";
import { generateImage, CodexHttpError, CodexTimeoutError, type GenerateOptions } from "./codex.js";
import {
  EMOTIONS as SHARED_EMOTIONS,
  EMOTION_PROMPTS as SHARED_EMOTION_PROMPTS,
  type Emotion,
} from "@hent-ai/shared";

export const EMOTIONS = SHARED_EMOTIONS;
export type { Emotion };

const EMOTION_PROMPTS: Record<string, string> = SHARED_EMOTION_PROMPTS;
export const AUTO_GENERATE_CONCURRENCY = "auto";
export const DEFAULT_GENERATE_CONCURRENCY: GenerateConcurrency = AUTO_GENERATE_CONCURRENCY;
export const MAX_GENERATE_CONCURRENCY = 8;
export const AUTO_INITIAL_GENERATE_CONCURRENCY = MAX_GENERATE_CONCURRENCY;
export const AUTO_INITIAL_JITTER_MS = 2_000;
export const AUTO_RETRY_JITTER_MS = 3_000;
export type GenerateConcurrency = number | typeof AUTO_GENERATE_CONCURRENCY;

const RETRYABLE_HTTP_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "UND_ERR_SOCKET",
  "EPIPE",
]);

export interface GenerateAllOptions {
  /** Base character description (e.g. "cute orange cat") */
  character: string;
  /** Output directory for generated images */
  outputDir: string;
  /** Codex model to use */
  model?: string;
  /** Image dimensions (e.g. "1024x1024") */
  size?: string;
  /** Path to an existing base image — skips base generation if provided */
  baseImage?: string;
  /** Whether to keep base.png in the output directory (default: true) */
  keepBase?: boolean;
  /** Only regenerate these specific emotions (default: all) */
  only?: Emotion[];
  /** Maximum emotion variant generations to run at once, or "auto" for adaptive backoff. */
  concurrency?: GenerateConcurrency;
  /** Progress callback */
  onProgress?: (step: string, index: number, total: number) => void;
  /** Called when auto concurrency backs off or increases. */
  onConcurrencyChange?: (event: AdaptiveBatchEvent) => void;
  /** Delay before retrying after a retryable auto-concurrency failure. */
  retryDelayMs?: number;
  /** Maximum jitter before initial auto-mode requests. */
  initialJitterMs?: number;
  /** Maximum jitter added to retry backoff in auto mode. */
  retryJitterMs?: number;
}

const STYLE_SUFFIX = [
  "Style: modern Japanese visual novel CG art, bishoujo dating sim game illustration, high-quality 2D anime game CG, hand-drawn anime illustration, clean thin lineart, refined cel shading, soft ambient lighting, expressive glossy anime eyes, delicate facial features, elegant costume details, emotional storytelling atmosphere, cinematic composition.",
  "Art direction: clearly 2D, hand-drawn look, anime cel shading, controlled highlights, soft painted background, clean silhouette, appealing character-focused composition.",
  "Negative requirements: no 3D render, no semi-realistic rendering, no photorealistic lighting, no realistic skin pores, no plastic skin, no doll-like face, no Unreal Engine look, no Blender render, no hyperreal fabric, no over-rendered metallic lighting.",
  "Requirements: single scene, one coherent illustration, no character sheet, no panels, no turnaround views, no expression sheet, no color palette swatches, no reference sheet layout.",
].join(" ");

function buildBasePrompt(character: string): string {
  return `Create a polished single-scene 2D anime illustration. Character: ${character}. Scene: standing in a neutral pose facing forward, calm default expression, simple clean background. ${STYLE_SUFFIX}`;
}

function buildEmotionPrompt(character: string, emotion: Emotion): string {
  return `Create a polished single-scene 2D anime illustration. Character: ${character}. Scene: expressing ${emotion}: ${EMOTION_PROMPTS[emotion]}, simple clean background. ${STYLE_SUFFIX}`;
}

function pngBufferToDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export function normalizeGenerateConcurrency(concurrency?: GenerateConcurrency): GenerateConcurrency {
  if (concurrency === undefined) return DEFAULT_GENERATE_CONCURRENCY;
  if (concurrency === AUTO_GENERATE_CONCURRENCY) return concurrency;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_GENERATE_CONCURRENCY
  ) {
    throw new Error(
      `Invalid concurrency ${concurrency}. Expected an integer from 1 to ${MAX_GENERATE_CONCURRENCY}.`,
    );
  }
  return concurrency;
}

export function isRetryableGenerationError(error: unknown): boolean {
  if (error instanceof CodexTimeoutError) return true;
  if (error instanceof CodexHttpError) {
    return RETRYABLE_HTTP_CODES.has(error.statusCode);
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  }
  return false;
}

/**
 * Sliding-window pool: runs up to `concurrency` workers at once,
 * immediately starting the next item when any slot finishes.
 */
async function poolMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

export async function generateAllEmotions(
  options: GenerateAllOptions,
): Promise<Map<string, string>> {
  const {
    character,
    outputDir,
    model,
    size,
    baseImage,
    keepBase = true,
    onProgress,
    onConcurrencyChange,
    retryDelayMs = 1_000,
    initialJitterMs = AUTO_INITIAL_JITTER_MS,
    retryJitterMs = AUTO_RETRY_JITTER_MS,
  } = options;
  const emotionsToGenerate = options.only ?? [...EMOTIONS];
  const totalSteps = emotionsToGenerate.length + (baseImage ? 0 : 1);
  const concurrency = normalizeGenerateConcurrency(options.concurrency);

  // Generation phase: collect every image in memory and write nothing yet.
  // If any generation fails, the output directory is left untouched so a
  // previous successful set is never partially overwritten.

  let baseBuffer: Buffer | undefined;
  let baseDataUrl: string;
  let stepOffset = 0;

  if (baseImage) {
    const buf = await readFile(resolve(baseImage));
    baseDataUrl = pngBufferToDataUrl(buf);
  } else {
    onProgress?.("base", 0, totalSteps);

    const baseOptions: GenerateOptions = {
      prompt: buildBasePrompt(character),
      model,
      size: size ?? "1024x1024",
    };

    baseBuffer = await generateImage(baseOptions);
    baseDataUrl = pngBufferToDataUrl(baseBuffer);
    stepOffset = 1;
  }

  const generated: Array<{ emotion: Emotion; buffer: Buffer }> = [];

  const generateEmotion = async (
    emotion: Emotion,
    index: number,
  ): Promise<{ emotion: Emotion; buffer: Buffer }> => {
    onProgress?.(emotion, index + stepOffset, totalSteps);

    const genOptions: GenerateOptions = {
      prompt: buildEmotionPrompt(character, emotion),
      model,
      size: size ?? "1024x1024",
      referenceImages: [baseDataUrl],
    };

    return { emotion, buffer: await generateImage(genOptions) };
  };

  if (concurrency === AUTO_GENERATE_CONCURRENCY) {
    const adaptive = await runAdaptiveBatch({
      items: emotionsToGenerate,
      initialConcurrency: AUTO_INITIAL_GENERATE_CONCURRENCY,
      maxConcurrency: MAX_GENERATE_CONCURRENCY,
      maxAttempts: 3,
      retryDelayMs,
      retryJitterMs,
      initialJitterMs,
      isRetryableError: isRetryableGenerationError,
      onEvent: onConcurrencyChange,
      worker: generateEmotion,
    });
    generated.push(...adaptive.results);
  } else {
    const poolResults = await poolMap(
      emotionsToGenerate,
      concurrency,
      generateEmotion,
    );
    generated.push(...poolResults);
  }

  // Write phase: reached only after every generation succeeded.
  await mkdir(outputDir, { recursive: true });

  const results = new Map<string, string>();

  if (baseBuffer && keepBase) {
    const basePath = resolve(outputDir, "base.png");
    await writeFile(basePath, baseBuffer);
    results.set("base", basePath);
  }

  for (const { emotion, buffer } of generated) {
    const outPath = resolve(outputDir, `${emotion}.png`);
    await writeFile(outPath, buffer);
    results.set(emotion, outPath);
  }

  return results;
}
