import { CANONICAL_EMOTIONS, type Emotion } from "../../../shared/emotions.js";

export const SEMANTIC_ASSET_TAGS_SCHEMA_VERSION = "SemanticAssetTagsV1" as const;

export type SemanticAssetTagsV1 = {
  readonly schemaVersion: typeof SEMANTIC_ASSET_TAGS_SCHEMA_VERSION;
  readonly emotion: Emotion;
  readonly gesture: string;
  readonly expression: string;
  readonly background: string;
  readonly clothing: string;
  readonly composition: string;
  readonly lighting: string;
  readonly mood: string;
};

const TAG_KEYS = [
  "schemaVersion",
  "emotion",
  "gesture",
  "expression",
  "background",
  "clothing",
  "composition",
  "lighting",
  "mood",
] as const;

const CANONICAL_EMOTION_SET = new Set<string>(CANONICAL_EMOTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized.length > 0 && normalized.length <= 160 ? normalized : null;
}

export function parseSemanticAssetTagsV1(value: unknown): SemanticAssetTagsV1 | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !(TAG_KEYS as readonly string[]).includes(key))) return null;
  if (value.schemaVersion !== SEMANTIC_ASSET_TAGS_SCHEMA_VERSION) return null;
  if (typeof value.emotion !== "string" || !CANONICAL_EMOTION_SET.has(value.emotion)) return null;

  const gesture = normalizedTag(value.gesture);
  const expression = normalizedTag(value.expression);
  const background = normalizedTag(value.background);
  const clothing = normalizedTag(value.clothing);
  const composition = normalizedTag(value.composition);
  const lighting = normalizedTag(value.lighting);
  const mood = normalizedTag(value.mood);
  if (!gesture || !expression || !background || !clothing || !composition || !lighting || !mood) return null;

  return {
    schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
    emotion: value.emotion as Emotion,
    gesture,
    expression,
    background,
    clothing,
    composition,
    lighting,
    mood,
  };
}

export function semanticAssetTagsFromMetadata(value: unknown): SemanticAssetTagsV1 | null {
  const direct = parseSemanticAssetTagsV1(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  return parseSemanticAssetTagsV1(value.tags ?? value.semanticTags);
}
