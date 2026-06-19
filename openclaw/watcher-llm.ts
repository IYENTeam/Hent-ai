// LLM layer for the anti-fixation watcher (OpenClaw side). Pure logic — prompts,
// strict response parsing, deterministic moderation, and a factory that produces
// the injected critic/generator/moderator from a single `chat` function. The
// actual provider HTTP call is supplied by the caller (index.ts), so this module
// is fully unit-testable with a mocked chat and stays at 100% coverage.

import type { InternalAntiFixationSignal, NeutralConversationContext } from "./watcher-core.js";
import type {
  CriticResult,
  WatcherCritic,
  WatcherGenerator,
  WatcherModerator,
} from "./watcher-adapter.js";

/** `chat(userPrompt, systemPrompt?)` -> model text, or null on any failure. */
export type ChatFn = (prompt: string, system?: string) => Promise<string | null>;

export const MAX_NUDGE_CHARS = 240;
export const CRITIC_SYSTEM =
  "You judge whether an AI agent is fixating: repeating the same topic or near-identical wording across its recent turns instead of advancing. Reply ONLY with compact JSON.";

/** Disallowed substrings in a delivered nudge (links, mass mentions, media injection). */
export const DISALLOWED_NUDGE_TOKENS = ["http://", "https://", "@everyone", "@here", "MEDIA:"];

export function buildCriticPrompt(context: NeutralConversationContext, recentTexts: string[]): string {
  const recent = recentTexts.slice(-5).map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    `Current topic: ${context.currentTopic}`,
    `Recent agent turns:`,
    recent,
    "",
    'Is the agent fixating (repeating itself on one topic)? Reply ONLY as {"fixated": boolean, "confidence": number between 0 and 1}.',
  ].join("\n");
}

export function parseCriticResponse(text: string | null): CriticResult | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.fixated !== "boolean") return null;
  if (typeof obj.confidence !== "number") return null;
  if (obj.confidence < 0 || obj.confidence > 1) return null;
  return { fixated: obj.fixated, confidence: obj.confidence };
}

export function buildGenerationPrompt(
  signal: InternalAntiFixationSignal,
  context: NeutralConversationContext,
  persona?: string,
): { system: string; user: string } {
  const base =
    "You are the agent itself. Write ONE short, in-character line that gently pivots away from the over-repeated topic to a fresh angle. No meta-commentary, no apology, no preamble.";
  return {
    system: persona ? `${persona}\n${base}` : base,
    user: [
      `You have repeated "${signal.staleFrame}" across recent turns.`,
      `Suggested pivot: ${signal.suggestedPivot}`,
      `Current topic: ${context.currentTopic}`,
      "Write the single pivot line now.",
    ].join("\n"),
  };
}

/** Deterministic cringe/safety guard. Text-only (no signal); fail-closed on anything risky. */
export function moderateNudge(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_NUDGE_CHARS) return false;
  const lowered = trimmed.toLowerCase();
  return !DISALLOWED_NUDGE_TOKENS.some((token) => lowered.includes(token.toLowerCase()));
}

export function createWatcherLlm(
  chat: ChatFn,
  persona?: string,
): { critic: WatcherCritic; generate: WatcherGenerator; moderate: WatcherModerator } {
  return {
    critic: async ({ context, recentTexts }) =>
      parseCriticResponse(await chat(buildCriticPrompt(context, recentTexts), CRITIC_SYSTEM)),
    generate: async ({ signal, context }) => {
      const { system, user } = buildGenerationPrompt(signal, context, persona);
      const out = await chat(user, system);
      const cleaned = out ? out.trim() : "";
      return cleaned.length > 0 ? cleaned : null;
    },
    moderate: (text: string) => moderateNudge(text),
  };
}
