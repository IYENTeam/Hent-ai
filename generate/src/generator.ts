import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateImage, type GenerateOptions } from "./codex.js";

export const EMOTIONS = [
  "happy",
  "neutral",
  "loyalty",
  "sorry",
  "confused",
  "focused",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

const EMOTION_PROMPTS: Record<Emotion, string> = {
  happy: "smiling brightly, giving a thumbs up, celebrating with joy",
  neutral: "calm and relaxed, default resting expression, at ease",
  loyalty: "saluting attentively, nodding with respect, ready to help",
  sorry: "looking apologetic, bowing slightly, sheepish expression",
  confused: "tilting head with a puzzled look, question mark above head",
  focused: "concentrating intensely, determined expression, working hard",
};

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
  /** Progress callback */
  onProgress?: (step: string, index: number, total: number) => void;
}

function buildBasePrompt(character: string): string {
  return `${character}, standing in a neutral pose facing forward. Simple clean background, consistent art style, square format, high quality PNG. This is a character reference sheet — no extreme emotion, just the character clearly visible.`;
}

function buildEmotionPrompt(character: string, emotion: Emotion): string {
  return `${character}, expressing ${emotion}: ${EMOTION_PROMPTS[emotion]}. Simple clean background, consistent art style, square format, high quality PNG`;
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
  const results = new Map<string, string>();
  const totalSteps = EMOTIONS.length + (baseImage ? 0 : 1);

  await mkdir(outputDir, { recursive: true });

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

    const baseBuffer = await generateImage(baseOptions);
    baseDataUrl = pngBufferToDataUrl(baseBuffer);

    if (keepBase) {
      const basePath = resolve(outputDir, "base.png");
      await writeFile(basePath, baseBuffer);
      results.set("base", basePath);
    }

    stepOffset = 1;
  }

  for (let i = 0; i < EMOTIONS.length; i++) {
    const emotion = EMOTIONS[i];
    onProgress?.(emotion, i + stepOffset, totalSteps);

    const genOptions: GenerateOptions = {
      prompt: buildEmotionPrompt(character, emotion),
      model,
      size: size ?? "1024x1024",
      referenceImages: [baseDataUrl],
    };

    const pngBuffer = await generateImage(genOptions);
    const outPath = resolve(outputDir, `${emotion}.png`);
    await writeFile(outPath, pngBuffer);
    results.set(emotion, outPath);
  }

  return results;
}
