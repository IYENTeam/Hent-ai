export const EMOTION_CONTRACT_VERSION = "EmotionContractV1";

export const CANONICAL_EMOTIONS = [
  "sorry",
  "happy",
  "confused",
  "focused",
  "loyalty",
  "neutral",
] as const;

export type Emotion = (typeof CANONICAL_EMOTIONS)[number];

export interface EmotionDefinition {
  id: Emotion;
  defaultFile: string;
  patterns: RegExp[];
  promptSuffix: string;
  label: string;
}

// Order matters: rule-based detection returns first match.
// To add a new emotion, add one entry here — all derived constants update automatically.
export const EMOTION_DEFINITIONS: readonly EmotionDefinition[] = [
  {
    id: "sorry",
    defaultFile: "sorry.png",
    patterns: [
      /sorry|apolog|my bad|mistake|messed up|regret|oops/i,
      /죄송|미안|실수|잘못|에러가? 발생|오류가? 발생|버그.*발견|실패/i,
    ],
    promptSuffix: "looking apologetic, bowing slightly, sheepish expression",
    label: "죄송...",
  },
  {
    id: "happy",
    defaultFile: "happy.png",
    patterns: [
      /done|complete|succeed|fixed|shipped|great|awesome|excellent|perfect|nailed|pass|resolved|✅|🎉|🔥/i,
      /proud|happy|fantastic|wonderful|congrats|celebrate|woohoo|yay/i,
      /완료|성공|통과|해결|고쳤|수정.*완료|빌드.*성공|테스트.*통과|잘 ?됐|문제.*없/i,
    ],
    promptSuffix: "smiling brightly, giving a thumbs up, celebrating with joy",
    label: "완료!",
  },
  {
    id: "confused",
    defaultFile: "confused.png",
    patterns: [
      /confused|unclear|not sure|strange|unknown cause|weird|unexpected/i,
      /question|how do we|how should|what should|any idea|could you clarify/i,
      /확인.*필요|불확실|잘 ?모르|애매|이해가 안|의미가|어떤.*의미|모호|추가.*정보/i,
    ],
    promptSuffix: "tilting head with a puzzled look, question mark above head",
    label: "음...",
  },
  {
    id: "focused",
    defaultFile: "focused.png",
    patterns: [
      /investigating|debugging|analyzing|implementing|working on|coding|building/i,
      /in progress|checking|processing|deploying|testing|verifying|reviewing|reading/i,
      /분석|조사|확인|살펴|디버깅|검토|읽[어고]|찾[아고]|작업 ?중|처리 ?중|검사/i,
    ],
    promptSuffix: "concentrating intensely, determined expression, working hard",
    label: "분석 중...",
  },
  {
    id: "loyalty",
    defaultFile: "loyalty.png",
    patterns: [
      /got it|understood|on it|yes sir|will do|right away|hello|hi there|sure thing/i,
      /네[,.]?|알겠|이해했|시작하겠|바로|확인했|말씀대로|지시.*따[르라]|접수/i,
    ],
    promptSuffix: "saluting attentively, nodding with respect, ready to help",
    label: "알겠습니다",
  },
  {
    id: "neutral",
    defaultFile: "neutral.png",
    patterns: [],
    promptSuffix: "calm and relaxed, default resting expression, at ease",
    label: "평온",
  },
] as const;

export const EMOTIONS: readonly Emotion[] = CANONICAL_EMOTIONS;

export const DEFAULT_EMOTION: Emotion = "neutral";

export const DEFAULT_EMOTION_MAP: Record<Emotion, string> = Object.fromEntries(
  EMOTION_DEFINITIONS.map((d) => [d.id, d.defaultFile]),
) as Record<Emotion, string>;

export const EMOTION_RULES: Array<{ emotion: Emotion; patterns: RegExp[] }> =
  EMOTION_DEFINITIONS.filter((d) => d.patterns.length > 0).map((d) => ({
    emotion: d.id,
    patterns: [...d.patterns],
  }));

export const EMOTION_PROMPTS: Record<Emotion, string> = Object.fromEntries(
  EMOTION_DEFINITIONS.map((d) => [d.id, d.promptSuffix]),
) as Record<Emotion, string>;

export const EMOTION_LABELS: Record<Emotion, string> = Object.fromEntries(
  EMOTION_DEFINITIONS.map((d) => [d.id, d.label]),
) as Record<Emotion, string>;

export const VALID_EMOTIONS: readonly Emotion[] = EMOTIONS;
