export type UserIntent =
  | { type: "positive" }
  | { type: "regenerate" }
  | { type: "skip" }
  | { type: "cancel" }
  | { type: "use_as_base" }
  | { type: "use_as_reference" }
  | { type: "feedback"; text: string };

const POSITIVE = /^(좋아|ㅇㅇ|ok|good|yes|완벽|이거|넘좋|굿|���ㅋ|확인|진행|next|네|응|ㅇ|좋아요|괜찮|맘에.?들)/i;
const REGENERATE = /^(다시|재생성|retry|again|ㄴㄴ|별로|nope|no)\s*$/i;
const SKIP = /^(스킵|skip|건너뛰기|넘어가|패스)/i;
const CANCEL = /^(취소|cancel|quit|종료|그만)/i;
const USE_AS_BASE = /^(1|그대로|그거|사용|use|as.?is|이거로|이걸로)/i;
const USE_AS_REF = /^(2|참고|레퍼런스|reference|새로|생성|new)/i;
const TRIGGER = /^(onboarding|온보딩|셋업|setup)\s*$/i;

export function parseIntent(text: string): UserIntent {
  const trimmed = text.trim();

  if (CANCEL.test(trimmed)) return { type: "cancel" };
  if (SKIP.test(trimmed)) return { type: "skip" };
  if (POSITIVE.test(trimmed)) return { type: "positive" };
  if (REGENERATE.test(trimmed)) return { type: "regenerate" };
  if (USE_AS_BASE.test(trimmed)) return { type: "use_as_base" };
  if (USE_AS_REF.test(trimmed)) return { type: "use_as_reference" };

  return { type: "feedback", text: trimmed };
}

export function parseImageIntent(text: string): UserIntent {
  const trimmed = text.trim();

  if (CANCEL.test(trimmed)) return { type: "cancel" };
  if (USE_AS_BASE.test(trimmed)) return { type: "use_as_base" };
  if (USE_AS_REF.test(trimmed)) return { type: "use_as_reference" };

  return { type: "feedback", text: trimmed };
}

export function isTrigger(text: string): boolean {
  return TRIGGER.test(text.trim());
}
