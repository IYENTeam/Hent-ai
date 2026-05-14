import type { Emotion } from "./session.js";

const EMOTION_DESCRIPTORS: Record<Emotion, string> = {
  happy: "smiling brightly, giving a thumbs up, celebrating with joy",
  neutral: "calm and relaxed, default resting expression, at ease",
  loyalty: "saluting attentively, nodding with respect, ready to help",
  sorry: "looking apologetic, bowing slightly, sheepish expression",
  confused: "tilting head with a puzzled look, question mark above head",
  focused: "concentrating intensely, determined expression, working hard",
};

const STYLE_SUFFIX = [
  "Style: modern Japanese visual novel CG art, bishoujo dating sim game illustration, high-quality 2D anime game CG, hand-drawn anime illustration, clean thin lineart, refined cel shading, soft ambient lighting, expressive glossy anime eyes, delicate facial features, elegant costume details, emotional storytelling atmosphere, cinematic composition.",
  "Art direction: clearly 2D, hand-drawn look, anime cel shading, controlled highlights, soft painted background, clean silhouette, appealing character-focused composition.",
  "Negative requirements: no 3D render, no semi-realistic rendering, no photorealistic lighting, no realistic skin pores, no plastic skin, no doll-like face, no Unreal Engine look, no Blender render, no hyperreal fabric, no over-rendered metallic lighting.",
  "Requirements: single scene, one coherent illustration, no character sheet, no panels, no turnaround views, no expression sheet, no color palette swatches, no reference sheet layout.",
].join(" ");

export function buildBasePrompt(character: string, feedback: string[]): string {
  let prompt = `Create a polished single-scene 2D anime illustration. Character: ${character}. Scene: standing in a neutral pose facing forward, calm default expression, simple clean background. ${STYLE_SUFFIX}`;
  if (feedback.length > 0) {
    prompt += ` Additional requirements: ${feedback.join(", ")}.`;
  }
  return prompt;
}

export function buildEmotionPrompt(
  character: string,
  emotion: Emotion,
  feedback: string[],
): string {
  let prompt = `Create a polished single-scene 2D anime illustration. Character: ${character}. Scene: expressing ${emotion}: ${EMOTION_DESCRIPTORS[emotion]}, simple clean background. ${STYLE_SUFFIX}`;
  if (feedback.length > 0) {
    prompt += ` Additional requirements: ${feedback.join(", ")}.`;
  }
  return prompt;
}
