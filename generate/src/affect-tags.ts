import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AFFECT_DIMENSIONS,
  AFFECT_SPACE_VERSION,
  VISUAL_AFFECT_SCHEMA_VERSION,
  parseVisualAffectV2,
  type VisualAffectV2,
} from "../../shared/affect.js";
import type { SemanticGenerationItem, SemanticGenerationPlanV1 } from "./semantic-plan.js";

export const VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION = "VisualAffectCollectionV2" as const;
export const VISUAL_AFFECT_PROMPT_VERSION = "visual-affect-pixels-v2" as const;

export type VisualAffectCollectionV2 = {
  readonly schemaVersion: typeof VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION;
  readonly affectSpaceVersion: typeof AFFECT_SPACE_VERSION;
  readonly items: Readonly<Record<string, VisualAffectV2>>;
};

export interface OfflineVisualAffectTagger {
  readonly invoke: (input: {
    readonly prompt: string;
    readonly imagePath: string;
    readonly item: SemanticGenerationItem;
  }) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapJsonFence(value: string): string {
  const trimmed = value.trim();
  return trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
}

export function parseInjectedVisualAffectV2(output: unknown): VisualAffectV2 {
  let value = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(unwrapJsonFence(output)) as unknown;
    } catch {
      throw new Error("Injected LLM visual affect output is not valid JSON");
    }
  }
  if (isRecord(value) && "affect" in value && Object.keys(value).length === 1) value = value.affect;
  const affect = parseVisualAffectV2(value);
  if (!affect) throw new Error("Injected LLM visual affect output does not match VisualAffectV2");
  return affect;
}

export function buildVisualAffectTagPrompt(): string {
  return [
    "Inspect only the actual image pixels. Do not infer emotion from the filename, generation prompt, or planned label.",
    `Return only one JSON object with schemaVersion ${VISUAL_AFFECT_SCHEMA_VERSION} and affectSpaceVersion ${AFFECT_SPACE_VERSION}.`,
    `Return exactly these dimensions, each as a number in [0,1]: ${AFFECT_DIMENSIONS.join(", ")}.`,
    "Use valence=0 for strongly unpleasant and 1 for strongly pleasant; arousal=0 for still and 1 for highly activated; dominance=0 for submissive and 1 for dominant.",
    "Judge visible emotion, mixed affect, facial cues, gaze, posture, and social tone. Do not force a single emotion class.",
    "Also return confidence in [0,1] and 1-12 concise evidence strings grounded in visible pixels. Omit source; the caller binds provenance.",
  ].join(" ");
}

async function writeJsonExclusiveOrResume(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== body) throw new Error(`Refusing to overwrite immutable visual affect tags at ${path}`);
  }
}

export async function tagVisualAffectOffline(options: {
  readonly setDir: string;
  readonly item: SemanticGenerationItem;
  readonly tagger: OfflineVisualAffectTagger;
  readonly model: string;
  readonly taggedAt?: string;
}): Promise<VisualAffectV2> {
  const imagePath = resolve(options.setDir, options.item.filename);
  const image = await readFile(imagePath);
  const output = await options.tagger.invoke({ prompt: buildVisualAffectTagPrompt(), imagePath, item: options.item });
  const parsed = parseInjectedVisualAffectV2(output);
  const affect: VisualAffectV2 = {
    ...parsed,
    source: {
      model: options.model,
      taggedAt: options.taggedAt ?? new Date().toISOString(),
      imageSha256: createHash("sha256").update(image).digest("hex"),
      promptVersion: VISUAL_AFFECT_PROMPT_VERSION,
    },
  };
  await writeJsonExclusiveOrResume(resolve(options.setDir, ".affect", `${options.item.id}.json`), affect);
  return affect;
}

export async function compileVisualAffectCollection(options: {
  readonly setDir: string;
  readonly plan: SemanticGenerationPlanV1;
}): Promise<VisualAffectCollectionV2> {
  const items: Record<string, VisualAffectV2> = {};
  for (const item of options.plan.items) {
    const affect = parseVisualAffectV2(JSON.parse(await readFile(resolve(options.setDir, ".affect", `${item.id}.json`), "utf8")) as unknown);
    if (!affect?.source) throw new Error(`Invalid or unbound visual affect tags for ${item.id}`);
    const actualHash = createHash("sha256").update(await readFile(resolve(options.setDir, item.filename))).digest("hex");
    if (affect.source.imageSha256 !== actualHash) throw new Error(`Visual affect hash mismatch for ${item.id}`);
    items[item.filename] = affect;
  }
  const collection: VisualAffectCollectionV2 = {
    schemaVersion: VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    items,
  };
  await writeJsonExclusiveOrResume(resolve(options.setDir, "affect-vectors.json"), collection);
  return collection;
}
