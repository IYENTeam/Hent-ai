import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CANONICAL_EMOTIONS, type Emotion } from "../../shared/emotions.js";
import {
  SEMANTIC_CONTROLLED_VOCABULARIES,
  type SemanticGenerationItem,
  type SemanticGenerationPlanV1,
} from "./semantic-plan.js";

export const SEMANTIC_ASSET_TAGS_SCHEMA_VERSION = "SemanticAssetTagsV1" as const;
export const SEMANTIC_TAG_COLLECTION_SCHEMA_VERSION = "SemanticAssetTagCollectionV1" as const;

export interface SemanticAssetTagsV1 {
  readonly schemaVersion: typeof SEMANTIC_ASSET_TAGS_SCHEMA_VERSION;
  readonly emotion: Emotion;
  readonly gesture: string;
  readonly expression: string;
  readonly background: string;
  readonly clothing: string;
  readonly composition: string;
  readonly lighting: string;
  readonly mood: string;
}

export interface SemanticAssetTagCollectionV1 {
  readonly schemaVersion: typeof SEMANTIC_TAG_COLLECTION_SCHEMA_VERSION;
  readonly items: Readonly<Record<string, SemanticAssetTagsV1>>;
}

export interface OfflineSemanticTagger {
  readonly invoke: (input: {
    readonly prompt: string;
    readonly imagePath: string;
    readonly item: SemanticGenerationItem;
  }) => Promise<unknown>;
}

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
  if (typeof value.emotion !== "string" || !(CANONICAL_EMOTIONS as readonly string[]).includes(value.emotion)) return null;
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

function unwrapJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]! : trimmed;
}

export function parseInjectedLlmSemanticTags(output: unknown): SemanticAssetTagsV1 {
  let value = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(unwrapJsonFence(output)) as unknown;
    } catch {
      throw new Error("Injected LLM semantic tag output is not valid JSON");
    }
  }
  if (isRecord(value) && "tags" in value && Object.keys(value).length === 1) value = value.tags;
  const tags = parseSemanticAssetTagsV1(value);
  if (!tags) throw new Error("Injected LLM semantic tag output does not match SemanticAssetTagsV1");
  return tags;
}

export function assertControlledSemanticTags(
  tags: SemanticAssetTagsV1,
  item: SemanticGenerationItem,
): void {
  if (tags.emotion !== item.emotion) throw new Error(`Semantic tags for ${item.id} must preserve planned emotion ${item.emotion}`);
  for (const axis of ["gesture", "expression", "background", "clothing"] as const) {
    const vocabulary = SEMANTIC_CONTROLLED_VOCABULARIES[axis] as readonly string[];
    if (!vocabulary.includes(tags[axis])) throw new Error(`Semantic tags for ${item.id} use unknown ${axis} value`);
  }
}

export function buildOfflineSemanticTagPrompt(item: SemanticGenerationItem): string {
  return [
    "Inspect the actual image pixels independently of its generation prompt.",
    `Return only one JSON object with schemaVersion ${SEMANTIC_ASSET_TAGS_SCHEMA_VERSION}.`,
    `The emotion must be ${item.emotion}.`,
    `Choose gesture from: ${SEMANTIC_CONTROLLED_VOCABULARIES.gesture.join(" | ")}.`,
    `Choose expression from: ${SEMANTIC_CONTROLLED_VOCABULARIES.expression.join(" | ")}.`,
    `Choose background from: ${SEMANTIC_CONTROLLED_VOCABULARIES.background.join(" | ")}.`,
    `Choose clothing from: ${SEMANTIC_CONTROLLED_VOCABULARIES.clothing.join(" | ")}.`,
    "Also provide concise non-empty composition, lighting, and mood strings. Do not add keys or commentary.",
  ].join(" ");
}

async function writeJsonExclusiveOrResume(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== body) throw new Error(`Refusing to overwrite immutable semantic tags at ${path}`);
  }
}

export async function tagSemanticAssetOffline(options: {
  readonly setDir: string;
  readonly item: SemanticGenerationItem;
  readonly tagger: OfflineSemanticTagger;
}): Promise<SemanticAssetTagsV1> {
  const imagePath = resolve(options.setDir, options.item.filename);
  await readFile(imagePath);
  const output = await options.tagger.invoke({
    prompt: buildOfflineSemanticTagPrompt(options.item),
    imagePath,
    item: options.item,
  });
  const tags = parseInjectedLlmSemanticTags(output);
  assertControlledSemanticTags(tags, options.item);
  await writeJsonExclusiveOrResume(resolve(options.setDir, ".tags", `${options.item.id}.json`), tags);
  return tags;
}

export async function compileSemanticTagCollection(options: {
  readonly setDir: string;
  readonly plan: SemanticGenerationPlanV1;
}): Promise<SemanticAssetTagCollectionV1> {
  const items: Record<string, SemanticAssetTagsV1> = {};
  for (const item of options.plan.items) {
    const tags = parseSemanticAssetTagsV1(JSON.parse(await readFile(resolve(options.setDir, ".tags", `${item.id}.json`), "utf8")) as unknown);
    if (!tags) throw new Error(`Invalid offline semantic tags for ${item.id}`);
    assertControlledSemanticTags(tags, item);
    items[item.filename] = tags;
  }
  const collection: SemanticAssetTagCollectionV1 = {
    schemaVersion: SEMANTIC_TAG_COLLECTION_SCHEMA_VERSION,
    items,
  };
  await writeJsonExclusiveOrResume(resolve(options.setDir, "semantic-tags.json"), collection);
  return collection;
}
