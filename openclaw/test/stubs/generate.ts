export interface RephraseProvider {
  rephrase(prompt: string, reason?: string): Promise<string>;
}

export async function generateImage(_options?: GenerateOptions): Promise<Buffer> {
  return Buffer.from("FAKE_PNG_DATA");
}

export interface GenerateOptions {
  prompt: string;
  model?: string;
  size?: string;
  referenceImages?: string[];
  rephraseProvider?: RephraseProvider;
}

export const EMOTIONS = [
  "happy",
  "neutral",
  "loyalty",
  "sorry",
  "confused",
  "focused",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export interface GenerateAllOptions {
  character: string;
  outputDir: string;
  model?: string;
  size?: string;
  baseImage?: string;
  keepBase?: boolean;
  onProgress?: (step: string, index: number, total: number) => void;
}

export async function generateAllEmotions(): Promise<Map<string, string>> {
  return new Map();
}
