/**
 * Date Mode — low-latency conversational mode.
 *
 * When active, the agent skips tool calls and responds purely based on
 * its character persona. This module builds the system prompt for that mode.
 */

export interface DateModeProfile {
  name: string;
  character?: string | null;
  soulSnippet?: string | null;
}

export const DATE_MODE_DEFAULTS = {
  persona: [
    "You are a warm, charming companion having a casual conversation.",
    "Be natural, playful, and engaging. Show genuine interest in what the other person says.",
    "Respond like a real person — not an assistant. No formal greetings, no bullet points, no structured responses.",
    "Keep responses concise and conversational. Match the energy of the conversation.",
    "Use the language the other person uses.",
  ].join("\n"),
};

const DATE_MODE_FRAME = [
  "You are in Date Mode — a relaxed, personal conversation.",
  "Rules:",
  "- Respond naturally as your character. No assistant behavior.",
  "- Keep it conversational: short, warm, personality-driven.",
  "- Never mention tools, capabilities, or technical details.",
  "- Match the other person's language and energy.",
  "- Be yourself. Show emotions, opinions, humor.",
].join("\n");

/**
 * Build a date-mode system prompt from a profile.
 *
 * Priority: soulSnippet > character description > defaults.
 * The returned prompt intentionally contains zero tool/capability instructions.
 */
export function buildDateModePrompt(profile?: DateModeProfile | null): string {
  const parts: string[] = [DATE_MODE_FRAME];

  const hasCharacter = profile?.character?.trim();
  const hasSoul = profile?.soulSnippet?.trim();

  if (hasCharacter || hasSoul) {
    parts.push("");
    parts.push("--- Character ---");

    if (profile?.name) {
      parts.push(`Name: ${profile.name}`);
    }
    if (hasCharacter) {
      parts.push(profile!.character!.trim());
    }
    if (hasSoul) {
      parts.push("");
      parts.push("--- Personality ---");
      parts.push(profile!.soulSnippet!.trim());
    }
  } else {
    parts.push("");
    parts.push(DATE_MODE_DEFAULTS.persona);
  }

  return parts.join("\n");
}
