import { CANONICAL_EMOTIONS, type Emotion } from "@hent-ai/shared";

export const SEMANTIC_GENERATION_PLAN_SCHEMA_VERSION = "SemanticGenerationPlanV1" as const;
export const SEMANTIC_SET_ID = "gothic-semantic-v1";
export const SEMANTIC_ITEM_COUNT = 100;
export const SEMANTIC_BATCH_SIZE = 10;

export const SEMANTIC_REFERENCE_PATHS = [
  "assets/sets/gothic-v1/base.png",
  "assets/base_new.png",
  "assets/base_new3.png",
] as const;

export const SEMANTIC_CONTROLLED_VOCABULARIES = {
  gesture: [
    "open-palm greeting",
    "hand over heart",
    "double thumbs up",
    "thoughtful chin touch",
    "gentle salute",
    "pointing to notes",
    "clasped hands",
    "crossed arms",
    "holding skirt hem",
    "reaching toward viewer",
  ],
  expression: [
    "bright smile",
    "apologetic downcast gaze",
    "curious head tilt",
    "determined narrowed eyes",
    "loyal reassuring smile",
    "calm neutral gaze",
    "delighted laugh",
    "worried furrowed brow",
    "focused soft frown",
    "surprised wide eyes",
  ],
  background: [
    "moonlit gothic library",
    "rainy neon alley",
    "sunlit conservatory",
    "candlelit study",
    "snowy cathedral courtyard",
    "cozy velvet bedroom",
    "starry rooftop",
    "autumn rose garden",
    "arcane workshop",
    "misty lakeside",
  ],
  clothing: [
    "classic black burgundy gothic dress",
    "tailored velvet academy uniform",
    "lace-trimmed winter cape ensemble",
    "casual ribbon blouse and pleated skirt",
    "ornate moonlit ball gown",
    "practical corset vest and trousers",
    "soft knit cardigan over gothic dress",
    "formal military-inspired coat",
    "floral summer gothic dress",
    "hooded travel cloak",
  ],
} as const;

export type SemanticDiversityAxis = keyof typeof SEMANTIC_CONTROLLED_VOCABULARIES;

export interface SemanticGenerationItem {
  readonly index: number;
  readonly id: string;
  readonly batch: number;
  readonly filename: string;
  readonly emotion: Emotion;
  readonly gesture: string;
  readonly expression: string;
  readonly background: string;
  readonly clothing: string;
}

export interface SemanticGenerationPlanV1 {
  readonly schemaVersion: typeof SEMANTIC_GENERATION_PLAN_SCHEMA_VERSION;
  readonly setId: typeof SEMANTIC_SET_ID;
  readonly itemCount: typeof SEMANTIC_ITEM_COUNT;
  readonly batchSize: typeof SEMANTIC_BATCH_SIZE;
  readonly references: readonly string[];
  readonly controlledVocabularies: Record<SemanticDiversityAxis, readonly string[]>;
  readonly items: readonly SemanticGenerationItem[];
}

function itemAt(index: number): SemanticGenerationItem {
  const row = Math.floor(index / 10);
  const column = index % 10;
  const id = index.toString().padStart(3, "0");
  const emotion = CANONICAL_EMOTIONS[index % CANONICAL_EMOTIONS.length]!;
  return {
    index,
    id,
    batch: row,
    filename: `${emotion}-${id}.png`,
    emotion,
    gesture: SEMANTIC_CONTROLLED_VOCABULARIES.gesture[(row + column) % 10]!,
    expression: SEMANTIC_CONTROLLED_VOCABULARIES.expression[(row + column * 3) % 10]!,
    background: SEMANTIC_CONTROLLED_VOCABULARIES.background[row]!,
    clothing: SEMANTIC_CONTROLLED_VOCABULARIES.clothing[column]!,
  };
}

export function createSemanticGenerationPlan(): SemanticGenerationPlanV1 {
  return {
    schemaVersion: SEMANTIC_GENERATION_PLAN_SCHEMA_VERSION,
    setId: SEMANTIC_SET_ID,
    itemCount: SEMANTIC_ITEM_COUNT,
    batchSize: SEMANTIC_BATCH_SIZE,
    references: [...SEMANTIC_REFERENCE_PATHS],
    controlledVocabularies: {
      gesture: [...SEMANTIC_CONTROLLED_VOCABULARIES.gesture],
      expression: [...SEMANTIC_CONTROLLED_VOCABULARIES.expression],
      background: [...SEMANTIC_CONTROLLED_VOCABULARIES.background],
      clothing: [...SEMANTIC_CONTROLLED_VOCABULARIES.clothing],
    },
    items: Array.from({ length: SEMANTIC_ITEM_COUNT }, (_value, index) => itemAt(index)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function equalStringArrays(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function assertSemanticGenerationPlan(value: unknown): asserts value is SemanticGenerationPlanV1 {
  if (!isRecord(value)) throw new Error("Semantic generation plan must be an object");
  if (value.schemaVersion !== SEMANTIC_GENERATION_PLAN_SCHEMA_VERSION) throw new Error("Invalid semantic generation plan schemaVersion");
  if (value.setId !== SEMANTIC_SET_ID) throw new Error(`Semantic generation plan setId must be ${SEMANTIC_SET_ID}`);
  if (value.itemCount !== SEMANTIC_ITEM_COUNT || value.batchSize !== SEMANTIC_BATCH_SIZE) throw new Error("Semantic generation plan must declare exactly 100 items in batches of 10");
  if (!equalStringArrays(value.references, SEMANTIC_REFERENCE_PATHS)) throw new Error("Semantic generation plan reference bundle is not approved");
  if (!isRecord(value.controlledVocabularies)) throw new Error("Semantic generation plan controlled vocabularies are missing");
  for (const axis of Object.keys(SEMANTIC_CONTROLLED_VOCABULARIES) as SemanticDiversityAxis[]) {
    if (!equalStringArrays(value.controlledVocabularies[axis], SEMANTIC_CONTROLLED_VOCABULARIES[axis])) {
      throw new Error(`Semantic generation plan ${axis} vocabulary must contain the approved ten values in stable order`);
    }
  }

  if (!Array.isArray(value.items) || value.items.length !== SEMANTIC_ITEM_COUNT) throw new Error("Semantic generation plan must contain exactly 100 items");
  const expected = createSemanticGenerationPlan().items;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value.items[index];
    if (!isRecord(actual)) throw new Error(`Semantic generation item ${index} must be an object`);
    for (const [key, expectedValue] of Object.entries(expected[index]!)) {
      if (actual[key] !== expectedValue) throw new Error(`Semantic generation item ${index} has invalid ${key}`);
    }
    if (Object.keys(actual).length !== Object.keys(expected[index]!).length) throw new Error(`Semantic generation item ${index} contains unknown fields`);
  }

  const filenames = new Set(value.items.map((item) => (item as Record<string, unknown>).filename));
  const tuples = new Set(value.items.map((item) => {
    const record = item as Record<string, unknown>;
    return [record.gesture, record.expression, record.background, record.clothing].join("\u0000");
  }));
  if (filenames.size !== SEMANTIC_ITEM_COUNT || tuples.size !== SEMANTIC_ITEM_COUNT) throw new Error("Semantic generation filenames and four-axis tuples must be unique");

  const emotionCounts = Object.fromEntries(CANONICAL_EMOTIONS.map((emotion) => [emotion, 0])) as Record<Emotion, number>;
  for (const item of value.items) emotionCounts[(item as unknown as SemanticGenerationItem).emotion] += 1;
  const expectedCounts = [17, 17, 17, 17, 16, 16];
  if (!CANONICAL_EMOTIONS.every((emotion, index) => emotionCounts[emotion] === expectedCounts[index])) throw new Error("Semantic generation emotion coverage must be 17/17/17/17/16/16");
}

export function buildSemanticImagePrompt(item: SemanticGenerationItem): string {
  return [
    "Create one polished single-scene 2D anime visual-novel CG of the same adult gothic assistant shown in all three references.",
    "Preserve identity: long wavy dark burgundy hair, magenta-red eyes, paired circular black-and-magenta hair ornaments, delicate facial proportions, and black/burgundy gothic design language.",
    `Emotion: ${item.emotion}. Gesture: ${item.gesture}. Expression: ${item.expression}. Background: ${item.background}. Clothing: ${item.clothing}.`,
    "Use a coherent waist-up or three-quarter composition, refined cel shading, clean line art, and lighting appropriate to the scene.",
    "One character only; no text, watermark, collage, character sheet, panels, extra limbs, photorealism, or 3D rendering.",
  ].join(" ");
}
