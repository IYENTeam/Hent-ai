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
  const results = new Map<string, string>();
  const emotionCount = options.only?.length ?? EMOTIONS.length;
  const totalSteps = emotionCount + (baseImage ? 0 : 1);

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

  const emotionsToGenerate = options.only ?? [...EMOTIONS];

  for (let i = 0; i < emotionsToGenerate.length; i++) {
    const emotion = emotionsToGenerate[i];
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
