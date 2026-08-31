import { describe, expect, it } from "vitest";
import { SEMANTIC_ASSET_TAGS_SCHEMA_VERSION, type SemanticAssetTagsV1 } from "./contracts.js";
import { cosineSimilarity, parseSemanticVector, SEMANTIC_ASSET_VECTOR_DIMENSIONS, semanticVectorForTags, semanticVectorForText } from "./vector.js";

const tags: SemanticAssetTagsV1 = {
  schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
  emotion: "focused",
  gesture: "typing on keyboard",
  expression: "determined gaze",
  background: "neon server room",
  clothing: "black gothic jacket",
  composition: "medium portrait",
  lighting: "magenta rim light",
  mood: "intense concentration",
};

describe("deterministic semantic vectors", () => {
  it("produces deterministic normalized feature-hash vectors", () => {
    const first = semanticVectorForTags(tags);
    const second = semanticVectorForTags(tags);
    expect(first).toEqual(second);
    expect(first).toHaveLength(SEMANTIC_ASSET_VECTOR_DIMENSIONS);
    expect(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 12);
    expect(cosineSimilarity(first, second)).toBeCloseTo(1, 12);
  });

  it("shares features between final text and matching offline tags", () => {
    const query = semanticVectorForText("Working in the neon server room with intense concentration");
    expect(cosineSimilarity(query, semanticVectorForTags(tags))).toBeGreaterThan(0);
  });

  it("rejects malformed and zero vectors", () => {
    expect(parseSemanticVector([])).toBeNull();
    expect(parseSemanticVector(Array.from({ length: SEMANTIC_ASSET_VECTOR_DIMENSIONS }).fill(0))).toBeNull();
    expect(parseSemanticVector([...Array.from({ length: SEMANTIC_ASSET_VECTOR_DIMENSIONS - 1 }).fill(0), Number.NaN])).toBeNull();
  });
});
