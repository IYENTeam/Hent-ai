export const AFFECT_SPACE_VERSION = "AffectSpaceV2" as const;
export const VISUAL_AFFECT_SCHEMA_VERSION = "VisualAffectV2" as const;
export const RESPONSE_AFFECT_SCHEMA_VERSION = "ResponseAffectV2" as const;

export const AFFECT_DIMENSIONS = [
  "valence",
  "arousal",
  "dominance",
  "joy",
  "anger",
  "irritation",
  "sadness",
  "anxiety",
  "fear",
  "surprise",
  "confusion",
  "disgust",
  "embarrassment",
  "pride",
  "determination",
  "affection",
  "warmth",
  "playfulness",
  "teasing",
  "deference",
  "smileIntensity",
  "browTension",
  "eyeOpenness",
  "bodyOpenness",
] as const;

export type AffectDimension = (typeof AFFECT_DIMENSIONS)[number];
export type AffectDimensionsV2 = Readonly<Record<AffectDimension, number>>;

export type VisualAffectV2 = {
  readonly schemaVersion: typeof VISUAL_AFFECT_SCHEMA_VERSION;
  readonly affectSpaceVersion: typeof AFFECT_SPACE_VERSION;
  readonly dimensions: AffectDimensionsV2;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly source?: {
    readonly model: string;
    readonly taggedAt: string;
    readonly imageSha256: string;
    readonly promptVersion: string;
  };
};

export type ResponseAffectV2 = {
  readonly schemaVersion: typeof RESPONSE_AFFECT_SCHEMA_VERSION;
  readonly affectSpaceVersion: typeof AFFECT_SPACE_VERSION;
  readonly dimensions: AffectDimensionsV2;
  readonly confidence: number;
};

const DIMENSION_SET = new Set<string>(AFFECT_DIMENSIONS);

export const AFFECT_DISTANCE_WEIGHTS: Readonly<Record<AffectDimension, number>> = {
  valence: 1.5,
  arousal: 1.5,
  dominance: 1.25,
  joy: 2,
  anger: 2.5,
  irritation: 2.25,
  sadness: 2,
  anxiety: 1.75,
  fear: 1.75,
  surprise: 1.25,
  confusion: 1.75,
  disgust: 1.75,
  embarrassment: 1.5,
  pride: 1.25,
  determination: 1.5,
  affection: 1.75,
  warmth: 1.5,
  playfulness: 2,
  teasing: 1.75,
  deference: 1,
  smileIntensity: 1.5,
  browTension: 1.5,
  eyeOpenness: 1,
  bodyOpenness: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unitNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function parseAffectDimensionsV2(value: unknown): AffectDimensionsV2 | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).length !== AFFECT_DIMENSIONS.length || Object.keys(value).some((key) => !DIMENSION_SET.has(key))) return null;
  const dimensions = {} as Record<AffectDimension, number>;
  for (const key of AFFECT_DIMENSIONS) {
    const parsed = unitNumber(value[key]);
    if (parsed === null) return null;
    dimensions[key] = parsed;
  }
  return dimensions;
}

function normalizedEvidence(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return null;
  const evidence = value.map((item) => typeof item === "string" ? item.normalize("NFKC").trim().replace(/\s+/g, " ") : "");
  return evidence.every((item) => item.length > 0 && item.length <= 240) ? evidence : null;
}

export function parseVisualAffectV2(value: unknown): VisualAffectV2 | null {
  if (!isRecord(value) || value.schemaVersion !== VISUAL_AFFECT_SCHEMA_VERSION || value.affectSpaceVersion !== AFFECT_SPACE_VERSION) return null;
  const dimensions = parseAffectDimensionsV2(value.dimensions);
  const confidence = unitNumber(value.confidence);
  const evidence = normalizedEvidence(value.evidence);
  if (!dimensions || confidence === null || !evidence) return null;
  const source = isRecord(value.source)
    && typeof value.source.model === "string"
    && typeof value.source.taggedAt === "string"
    && typeof value.source.imageSha256 === "string"
    && /^[a-f0-9]{64}$/i.test(value.source.imageSha256)
    && typeof value.source.promptVersion === "string"
    ? {
        model: value.source.model.trim(),
        taggedAt: value.source.taggedAt.trim(),
        imageSha256: value.source.imageSha256.toLowerCase(),
        promptVersion: value.source.promptVersion.trim(),
      }
    : undefined;
  if (value.source !== undefined && (!source || Object.values(source).some((item) => !item))) return null;
  return {
    schemaVersion: VISUAL_AFFECT_SCHEMA_VERSION,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    dimensions,
    confidence,
    evidence,
    ...(source ? { source } : {}),
  };
}

export function parseResponseAffectV2(value: unknown): ResponseAffectV2 | null {
  if (!isRecord(value) || value.schemaVersion !== RESPONSE_AFFECT_SCHEMA_VERSION || value.affectSpaceVersion !== AFFECT_SPACE_VERSION) return null;
  const dimensions = parseAffectDimensionsV2(value.dimensions);
  const confidence = unitNumber(value.confidence);
  if (!dimensions || confidence === null) return null;
  return {
    schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    dimensions,
    confidence,
  };
}

export function affectVectorFromDimensions(dimensions: AffectDimensionsV2): number[] {
  return AFFECT_DIMENSIONS.map((key) => dimensions[key]);
}

export function parseAffectVectorV2(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== AFFECT_DIMENSIONS.length) return null;
  const vector = value.map(unitNumber);
  return vector.every((item): item is number => item !== null) ? vector : null;
}

export function affectVectorMatchesDimensions(vector: readonly number[], dimensions: AffectDimensionsV2): boolean {
  return vector.length === AFFECT_DIMENSIONS.length
    && AFFECT_DIMENSIONS.every((key, index) => Math.abs(vector[index]! - dimensions[key]) <= Number.EPSILON);
}

export function weightedAffectDistance(left: readonly number[], right: readonly number[]): number {
  if (left.length !== AFFECT_DIMENSIONS.length || right.length !== AFFECT_DIMENSIONS.length) return Number.POSITIVE_INFINITY;
  let weightedSquaredDifference = 0;
  let totalWeight = 0;
  for (let index = 0; index < AFFECT_DIMENSIONS.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return Number.POSITIVE_INFINITY;
    const weight = AFFECT_DISTANCE_WEIGHTS[AFFECT_DIMENSIONS[index]!];
    weightedSquaredDifference += weight * (leftValue - rightValue) ** 2;
    totalWeight += weight;
  }
  return Math.sqrt(weightedSquaredDifference / totalWeight);
}
