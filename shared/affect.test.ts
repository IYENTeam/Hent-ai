import { describe, expect, it } from "vitest";
import {
  AFFECT_DIMENSIONS,
  AFFECT_SPACE_VERSION,
  RESPONSE_AFFECT_SCHEMA_VERSION,
  VISUAL_AFFECT_SCHEMA_VERSION,
  affectVectorFromDimensions,
  parseResponseAffectV2,
  parseVisualAffectV2,
  weightedAffectDistance,
  type AffectDimensionsV2,
} from "./affect.js";

const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key, index) => [key, index / AFFECT_DIMENSIONS.length])) as AffectDimensionsV2;

describe("AffectSpaceV2", () => {
  it("strictly parses complete unit-range visual and response vectors", () => {
    expect(parseVisualAffectV2({
      schemaVersion: VISUAL_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions,
      confidence: 0.9,
      evidence: ["furrowed brows"],
    })?.dimensions).toEqual(dimensions);
    expect(parseResponseAffectV2({
      schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions,
      confidence: 0.8,
    })?.dimensions).toEqual(dimensions);
    expect(parseResponseAffectV2({
      schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions: { ...dimensions, anger: 1.1 },
      confidence: 0.8,
    })).toBeNull();
  });

  it("uses intensity-preserving weighted distance", () => {
    const vector = affectVectorFromDimensions(dimensions);
    expect(weightedAffectDistance(vector, vector)).toBe(0);
    const changed = [...vector];
    changed[AFFECT_DIMENSIONS.indexOf("anger")] = 1;
    expect(weightedAffectDistance(vector, changed)).toBeGreaterThan(0);
  });
});
