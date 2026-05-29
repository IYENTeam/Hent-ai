import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateImage, type GenerateOptions } from "./codex.js";
import {
  EMOTIONS as SHARED_EMOTIONS,
  EMOTION_PROMPTS as SHARED_EMOTION_PROMPTS,
  type Emotion,
} from "@hent-ai/shared";

export const EMOTIONS = SHARED_EMOTIONS;
export type { Emotion };

const EMOTION_PROMPTS: Record<string, string> = SHARED_EMOTION_PROMPTS;

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
  /** Progress callback */
  onProgress?: (step: string, index: number, total: number) => void;
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
  } = options;
  const emotionsToGenerate = options.only ?? [...EMOTIONS];
  const totalSteps = emotionsToGenerate.length + (baseImage ? 0 : 1);

  // Generation phase: collect every image in memory and write nothing yet.
  // If any generation fails, the output directory is left untouched so a
  // failed run can never leave a partial or old/new-mixed emotion set behind.
  let baseDataUrl: string;
  let baseBuffer: Buffer | null = null;
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

  for (let i = 0; i < emotionsToGenerate.length; i++) {
    const emotion = emotionsToGenerate[i];
    onProgress?.(emotion, i + stepOffset, totalSteps);

    const genOptions: GenerateOptions = {
      prompt: buildEmotionPrompt(character, emotion),
      model,
      size: size ?? "1024x1024",
      referenceImages: [baseDataUrl],
    };

    generated.push({ emotion, buffer: await generateImage(genOptions) });
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
