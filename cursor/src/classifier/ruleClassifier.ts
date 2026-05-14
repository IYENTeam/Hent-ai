import { Emotion, EmotionRule, DEFAULT_EMOTION, VALID_EMOTIONS } from "../types";

export const EMOTION_RULES: EmotionRule[] = [
  {
    emotion: "sorry",
    patterns: [
      /sorry|apolog|my bad|mistake|messed up|regret|oops/i,
      /죄송|미안|실수|잘못|에러가? 발생|오류가? 발생|버그.*발견|실패/i,
    ],
  },
  {
    emotion: "happy",
    patterns: [
      /done|complete|succeed|fixed|shipped|great|awesome|excellent|perfect|nailed|pass|resolved|✅|🎉|🔥/i,
      /proud|happy|fantastic|wonderful|congrats|celebrate|woohoo|yay/i,
      /완료|성공|통과|해결|고쳤|수정.*완료|빌드.*성공|테스트.*통과|잘 ?됐|문제.*없/i,
    ],
  },
  {
    emotion: "confused",
    patterns: [
      /confused|unclear|not sure|strange|unknown cause|weird|unexpected/i,
      /question|how do we|how should|what should|any idea|could you clarify/i,
      /확인.*필요|불확실|잘 ?모르|애매|이해가 안|의미가|어떤.*의미|모호|추가.*정보/i,
    ],
  },
  {
    emotion: "focused",
    patterns: [
      /investigating|debugging|analyzing|implementing|working on|coding|building/i,
      /in progress|checking|processing|deploying|testing|verifying|reviewing|reading/i,
      /분석|조사|확인|살펴|디버깅|검토|읽[어고]|찾[아고]|작업 ?중|처리 ?중|검사/i,
    ],
  },
  {
    emotion: "loyalty",
    patterns: [
      /got it|understood|on it|yes sir|will do|right away|hello|hi there|sure thing/i,
      /네[,.]?|알겠|이해했|시작하겠|바로|확인했|말씀대로|지시.*따[르라]|접수/i,
    ],
  },
];

export function detectEmotion(
  text: string,
  rules: EmotionRule[] = EMOTION_RULES,
  fallback: Emotion = DEFAULT_EMOTION,
): Emotion {
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return rule.emotion;
      }
    }
  }
  return fallback;
}

export function extractEmotion(raw: string | null | undefined): Emotion | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  const direct = VALID_EMOTIONS.find((e) => e === cleaned);
  if (direct) return direct;
  const found = VALID_EMOTIONS.find((e) => cleaned.includes(e));
  return found ?? null;
}
