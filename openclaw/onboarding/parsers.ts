export type ParsedIntent =
  | { type: "positive" }
  | { type: "regenerate" }
  | { type: "skip" }
  | { type: "cancel" }
  | { type: "use_as_base" }
  | { type: "use_as_reference" }
  | { type: "feedback"; text: string };

export type ParsedImageIntent =
  | { type: "use_as_base" }
  | { type: "use_as_reference" }
  | { type: "cancel" }
  | { type: "feedback"; text: string };

const TRIGGER_KEYWORDS = ["onboarding", "온보딩", "셋업", "setup"];
const MAX_TRIGGER_WORD_COUNT = 4;

export function isTrigger(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).length;
  if (wordCount > MAX_TRIGGER_WORD_COUNT) return false;
  return TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
}

export function parseIntent(text: string): ParsedIntent {
  const t = text.trim().toLowerCase();

  // Cancel takes priority
  if (/^(취소|cancel|종료|그만)$/.test(t)) return { type: "cancel" };

  // Regenerate
  if (/^(다시|재생성|retry|again)$/.test(t)) return { type: "regenerate" };

  // Skip
  if (/^(스킵|skip|건너뛰기)$/.test(t)) return { type: "skip" };

  // Positive
  if (/^(좋아|ㅇㅇ|ok|good|yes|완벽|ㅇㅋ|네|응|굿)$/i.test(t)) return { type: "positive" };

  // Image shortcuts
  if (t === "1") return { type: "use_as_base" };
  if (t === "2") return { type: "use_as_reference" };

  return { type: "feedback", text: text.trim() };
}

export function parseImageIntent(text: string): ParsedImageIntent {
  const t = text.trim().toLowerCase();

  if (/^(취소|cancel|종료|그만)$/.test(t)) return { type: "cancel" };
  if (/^(1|그대로|사용|이걸로|이대로)$/.test(t)) return { type: "use_as_base" };
  if (/^(2|참고|새로|새로운|새롭게)$/.test(t)) return { type: "use_as_reference" };

  return { type: "feedback", text: text.trim() };
}
