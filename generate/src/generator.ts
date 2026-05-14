import { writeFile, mkdir } from "node:fs/promises";
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
  prompt: string;
  outputDir: string;
  model?: string;
  size?: string;
  referenceImage?: string;
  onProgress?: (emotion: Emotion, index: number, total: number) => void;
}

function buildEmotionPrompt(basePrompt: string, emotion: Emotion): string {
  return `${basePrompt}, expressing ${emotion}: ${EMOTION_PROMPTS[emotion]}. Simple clean background, consistent art style, square format, high quality PNG`;
}

export async function generateAllEmotions(
  options: GenerateAllOptions,
): Promise<Map<Emotion, string>> {
  const { prompt, outputDir, model, size, referenceImage, onProgress } = options;
  const results = new Map<Emotion, string>();

  await mkdir(outputDir, { recursive: true });

  for (let i = 0; i < EMOTIONS.length; i++) {
    const emotion = EMOTIONS[i];
    onProgress?.(emotion, i, EMOTIONS.length);

    const genOptions: GenerateOptions = {
      prompt: buildEmotionPrompt(prompt, emotion),
      model,
      size: size ?? "1024x1024",
      referenceImages: referenceImage ? [referenceImage] : undefined,
    };

    const pngBuffer = await generateImage(genOptions);
    const outPath = resolve(outputDir, `${emotion}.png`);
    await writeFile(outPath, pngBuffer);
    results.set(emotion, outPath);
  }

  return results;
}
