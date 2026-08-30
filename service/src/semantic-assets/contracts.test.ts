import { describe, expect, it } from "vitest";
import { parseSemanticAssetTagsV1, semanticAssetTagsFromMetadata, SEMANTIC_ASSET_TAGS_SCHEMA_VERSION } from "./contracts.js";

const validTags = {
  schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
  emotion: "happy",
  gesture: "double thumbs up",
  expression: "bright smile",
  background: "moonlit library",
  clothing: "gothic velvet dress",
  composition: "waist-up portrait",
  lighting: "soft magenta rim light",
  mood: "triumphant",
} as const;

describe("SemanticAssetTagsV1", () => {
  it("validates and normalizes all required semantic axes", () => {
    expect(parseSemanticAssetTagsV1({ ...validTags, gesture: "  double   thumbs up  " })).toEqual(validTags);
    expect(semanticAssetTagsFromMetadata({ tags: validTags })).toEqual(validTags);
  });

  it.each([
    { ...validTags, schemaVersion: "SemanticAssetTagsV2" },
    { ...validTags, emotion: "excited" },
    { ...validTags, mood: "" },
    { ...validTags, composition: 42 },
    { ...validTags, extra: "not versioned" },
  ])("rejects malformed or incompatible records", (value) => {
    expect(parseSemanticAssetTagsV1(value)).toBeNull();
  });
});
