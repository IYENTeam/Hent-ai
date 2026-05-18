/**
 * Build the base character generation prompt.
 */
export function buildBasePrompt(character: string, feedback: string[] = []): string {
  const lines = [
    `Create a high-quality character image based on this description: ${character}`,
    "Style: clean, expressive, suitable for an AI assistant avatar.",
    "Format: square, PNG, simple background.",
  ];
  if (feedback.length > 0) {
    lines.push(`\nFeedback to incorporate:\n${feedback.map((f) => `- ${f}`).join("\n")}`);
  }
  return lines.join("\n");
}

/**
 * Build the emotion variant prompt.
 */
export function buildEmotionPrompt(character: string, emotion: string, feedback: string[] = []): string {
  const emotionDescriptions: Record<string, string> = {
    happy: "smiling, celebrating, thumbs up",
    neutral: "calm, relaxed, neutral expression",
    loyalty: "saluting, attentive, nodding",
    sorry: "apologetic, bowing slightly, sheepish",
    confused: "head tilt, puzzled, question mark expression",
    focused: "concentrating, working hard, determined",
  };
  const desc = emotionDescriptions[emotion] ?? emotion;
  const lines = [
    `Same character as described: ${character}`,
    `Expression: ${desc}`,
    "Keep the same art style, same character, simple background.",
    "Format: square, PNG.",
  ];
  if (feedback.length > 0) {
    lines.push(`\nFeedback to incorporate:\n${feedback.map((f) => `- ${f}`).join("\n")}`);
  }
  return lines.join("\n");
}
