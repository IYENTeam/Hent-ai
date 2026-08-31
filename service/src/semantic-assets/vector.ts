import { createHash } from "node:crypto";
import type { SemanticAssetTagsV1 } from "./contracts.js";

export const SEMANTIC_ASSET_VECTOR_DIMENSIONS = 256;

function tokensFor(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = [...words];
  for (let index = 0; index + 1 < words.length; index += 1) {
    tokens.push(`${words[index]}_${words[index + 1]}`);
  }
  return tokens;
}

export function normalizeSemanticVector(vector: readonly number[]): number[] | null {
  if (vector.length !== SEMANTIC_ASSET_VECTOR_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) return null;
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) return null;
  return vector.map((value) => value / magnitude);
}

export function featureHashVector(values: readonly string[]): number[] {
  const vector = Array.from<number>({ length: SEMANTIC_ASSET_VECTOR_DIMENSIONS }).fill(0);
  for (const token of values.flatMap(tokensFor)) {
    const digest = createHash("sha256").update(token).digest();
    const bucket = digest.readUInt32BE(0) % SEMANTIC_ASSET_VECTOR_DIMENSIONS;
    const sign = (digest[4]! & 1) === 0 ? 1 : -1;
    vector[bucket] = vector[bucket]! + sign;
  }
  return normalizeSemanticVector(vector) ?? vector;
}

export function semanticVectorForText(text: string): number[] {
  return featureHashVector([text]);
}

export function semanticVectorForTags(tags: SemanticAssetTagsV1): number[] {
  return featureHashVector([
    tags.emotion,
    tags.gesture,
    tags.expression,
    tags.background,
    tags.clothing,
    tags.composition,
    tags.lighting,
    tags.mood,
  ]);
}

export function parseSemanticVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) return null;
  return normalizeSemanticVector(value as number[]);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude <= Number.EPSILON || rightMagnitude <= Number.EPSILON) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}
