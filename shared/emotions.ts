export interface EmotionDefinition {
  id: string;
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

export const EMOTIONS = EMOTION_DEFINITIONS.map((d) => d.id);

export type Emotion = (typeof EMOTION_DEFINITIONS)[number]["id"];

export const DEFAULT_EMOTION: string = "neutral";

export const DEFAULT_EMOTION_MAP: Record<string, string> = Object.fromEntries(
  EMOTION_DEFINITIONS.map((d) => [d.id, d.defaultFile]),
);

export const EMOTION_RULES: Array<{ emotion: string; patterns: RegExp[] }> =
  EMOTION_DEFINITIONS.filter((d) => d.patterns.length > 0).map((d) => ({
    emotion: d.id,
    patterns: [...d.patterns],
  }));

export const EMOTION_PROMPTS: Record<string, string> = Object.fromEntries(
  EMOTION_DEFINITIONS.map((d) => [d.id, d.promptSuffix]),
);

export const EMOTION_LABELS: Record<string, string> = Object.fromEntries(
  EMOTION_DEFINITIONS.map((d) => [d.id, d.label]),
);

export const VALID_EMOTIONS: string[] = [...EMOTIONS];

export type ProfileMode = "default" | "date";

export const DATE_EMOTION_DEFINITIONS: readonly EmotionDefinition[] = [
  {
    id: "calm",
    defaultFile: "calm.png",
    patterns: [],
    promptSuffix: "calm and relaxed, serene expression, at peace",
    label: "평온",
  },
  {
    id: "happy",
    defaultFile: "happy.png",
    patterns: [
      /happy|glad|great|nice|wonderful|yay|haha|lol|ㅋㅋ|ㅎㅎ|재밌|좋[아았]|기[쁘분]|웃[기긴]|즐[거겁]/i,
    ],
    promptSuffix: "smiling warmly, eyes sparkling with joy, cheerful",
    label: "기분 좋아~",
  },
  {
    id: "shy",
    defaultFile: "shy.png",
    patterns: [
      /shy|blush|embarrass|fluster|어머|부끄|수줍|얼굴.*빨개|창피|쑥스|민망/i,
    ],
    promptSuffix: "blushing cheeks, looking away shyly, fidgeting hands",
    label: "부끄러워...",
  },
  {
    id: "excited",
    defaultFile: "excited.png",
    patterns: [
      /excited|can't wait|omg|wow|amazing|really|진짜|대박|설레|두근|기대|헐|와[!~]|신[나난]/i,
    ],
    promptSuffix: "eyes wide with excitement, bouncing with energy, sparkling aura",
    label: "두근두근!",
  },
  {
    id: "jealous",
    defaultFile: "jealous.png",
    patterns: [
      /jealous|envy|who is|another|other girl|other guy|질투|부러|누구|다른.*[여남]|바람/i,
    ],
    promptSuffix: "pouting with narrowed eyes, arms crossed, slightly turned away",
    label: "질투나...",
  },
  {
    id: "flirty",
    defaultFile: "flirty.png",
    patterns: [
      /flirt|tease|wink|cute|love you|like you|좋아해|사랑|귀여|애교|윙크|자기야|오빠|누나/i,
    ],
    promptSuffix: "winking playfully, finger on lips, mischievous smile",
    label: "애교~",
  },
  {
    id: "pouty",
    defaultFile: "pouty.png",
    patterns: [
      /hmph|mean|unfair|no fair|ignore|뿌잉|삐졌|서운|섭섭|무시|너무해|싫[어은]/i,
    ],
    promptSuffix: "puffed cheeks, looking away with a pout, arms crossed",
    label: "삐졌어!",
  },
  {
    id: "loving",
    defaultFile: "loving.png",
    patterns: [
      /love|adore|precious|dear|warm|thank|고마|소중|사랑[해스]|따뜻|감사|행복|함께/i,
    ],
    promptSuffix: "gentle warm smile, hands over heart, soft glowing aura, hearts floating",
    label: "사랑해♡",
  },
  {
    id: "sleepy",
    defaultFile: "sleepy.png",
    patterns: [
      /sleepy|tired|yawn|night|bed|good night|졸[려림]|피곤|자야|잘게|굿[나밤]|안녕히|나른/i,
    ],
    promptSuffix: "half-closed eyes, yawning softly, hugging a pillow",
    label: "졸려...",
  },
  {
    id: "surprised",
    defaultFile: "surprised.png",
    patterns: [
      /surprised|shock|what|no way|unbelievable|깜짝|놀[라랐]|헉|엥|뭐[?!]|설마|어[?!]/i,
    ],
    promptSuffix: "wide eyes, hands on cheeks, mouth open in surprise",
    label: "헉!",
  },
  {
    id: "sad",
    defaultFile: "sad.png",
    patterns: [
      /sad|miss you|lonely|cry|tear|upset|속상|슬[퍼픈]|보고.*싶|외로[워운]|울[었고]|눈물|그리[워운]/i,
    ],
    promptSuffix: "teary eyes, looking down sadly, holding back tears",
    label: "속상해...",
  },
] as const;

export const DATE_EMOTIONS = DATE_EMOTION_DEFINITIONS.map((d) => d.id);
export const DATE_DEFAULT_EMOTION: string = "calm";

export const DATE_EMOTION_MAP: Record<string, string> = Object.fromEntries(
  DATE_EMOTION_DEFINITIONS.map((d) => [d.id, d.defaultFile]),
);

export const DATE_EMOTION_RULES: Array<{ emotion: string; patterns: RegExp[] }> =
  DATE_EMOTION_DEFINITIONS.filter((d) => d.patterns.length > 0).map((d) => ({
    emotion: d.id,
    patterns: [...d.patterns],
  }));

export const DATE_EMOTION_PROMPTS: Record<string, string> = Object.fromEntries(
  DATE_EMOTION_DEFINITIONS.map((d) => [d.id, d.promptSuffix]),
);

export const DATE_EMOTION_LABELS: Record<string, string> = Object.fromEntries(
  DATE_EMOTION_DEFINITIONS.map((d) => [d.id, d.label]),
);
