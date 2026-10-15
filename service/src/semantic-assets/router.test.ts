import { afterEach, describe, expect, it, vi } from "vitest";
import * as affectSpace from "../../../shared/affect.js";
import { SEMANTIC_ASSET_TAGS_SCHEMA_VERSION, type SemanticAssetTagsV1 } from "./contracts.js";
import {
  AFFECT_DIMENSIONS,
  AFFECT_SPACE_VERSION,
  RESPONSE_AFFECT_SCHEMA_VERSION,
  VISUAL_AFFECT_SCHEMA_VERSION,
  affectVectorFromDimensions,
  type AffectDimensionsV2,
  type ResponseAffectV2,
  type VisualAffectV2,
} from "../../../shared/affect.js";
import type { SemanticAssetCandidate, SemanticAssetRepository } from "./ports.js";
import { DeterministicSemanticAssetRouter } from "./router.js";
import { SEMANTIC_ASSET_VECTOR_DIMENSIONS, semanticVectorForTags } from "./vector.js";

function tags(gesture: string, background: string): SemanticAssetTagsV1 {
  return {
    schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
    emotion: "happy",
    gesture,
    expression: "bright smile",
    background,
    clothing: "gothic velvet dress",
    composition: "waist-up portrait",
    lighting: "soft magenta rim light",
    mood: "joyful celebration",
  };
}

function candidate(filename: string, semanticTags: unknown, semanticVector: unknown, overrides: Partial<SemanticAssetCandidate> = {}): SemanticAssetCandidate {
  return {
    id: `asset-${filename}`,
    assetSetId: "mapped-set",
    emotion: "happy",
    filename,
    contentType: "image/png",
    objectUrl: `/static/sets/mapped-set/${filename}`,
    storageKey: `sets/mapped-set/${filename}`,
    semanticTags,
    semanticVector,
    ...overrides,
  };
}

function repository(candidates: readonly SemanticAssetCandidate[], assetSetId: string | null = "mapped-set"): SemanticAssetRepository {
  return {
    assetSetIdForChannel: () => assetSetId,
    listCandidates: () => candidates,
  };
}

function affectDimensions(overrides: Partial<AffectDimensionsV2> = {}): AffectDimensionsV2 {
  return { ...Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, 0])), ...overrides } as AffectDimensionsV2;
}

function visualAffect(overrides: Partial<AffectDimensionsV2> = {}): VisualAffectV2 {
  return {
    schemaVersion: VISUAL_AFFECT_SCHEMA_VERSION,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    dimensions: affectDimensions(overrides),
    confidence: 0.9,
    evidence: ["visible expression"],
  };
}

function responseAffect(overrides: Partial<AffectDimensionsV2> = {}): ResponseAffectV2 {
  return {
    schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    dimensions: affectDimensions(overrides),
    confidence: 0.9,
  };
}

function uniformDimensions(value: number): AffectDimensionsV2 {
  return affectDimensions(Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, value])));
}

function uniformCandidate(value: number): SemanticAssetCandidate {
  const tags = visualAffect(uniformDimensions(value));
  return candidate(`${value}.png`, tags, affectVectorFromDimensions(tags.dimensions));
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("DeterministicSemanticAssetRouter", () => {
  it("returns three nearest references including the selected image and a hand-computed p95", () => {
    // Uniform dimensions make weighted distances equal scalar differences.
    // LOO minima: .1, .1, .1, .2, .2, .4; nearest-rank p95 is rank 6 = .4.
    const router = new DeterministicSemanticAssetRouter(repository([0, 0.1, 0.2, 0.4, 0.6, 1].map(uniformCandidate)), () => 0);
    const selection = router.route({ channelId: "c1", text: "near", affect: responseAffect(uniformDimensions(0)) });
    expect(selection?.threshold).toBeCloseTo(0.4);
    expect(selection?.generate).toBe(false);
    expect(selection?.media.filename).toBe("0.png");
    expect(selection?.nearest?.map(({ media }) => media.filename)).toEqual(["0.png", "0.1.png", "0.2.png"]);
    selection?.nearest?.forEach(({ distance }, index) => expect(distance).toBeCloseTo(index / 10));
  });

  it.each([
    ["0", 0.05, true, 0],
    ["0", 0, false, 0],
    ["0.125", 0.125, false, 0.125],
    ["not-a-number", 0.05, true, 0],
    ["Infinity", 0.05, true, 0],
    ["", 0.05, true, 0],
  ])("honors override %s at distance %s with generate=%s", (override, value, generate, threshold) => {
    vi.stubEnv("HENT_AI_NATIVE_GENERATE_DISTANCE", override);
    const selection = new DeterministicSemanticAssetRouter(repository([uniformCandidate(0)])).route({
      channelId: "c1", text: "override", affect: responseAffect(uniformDimensions(value)),
    });
    expect(selection).toMatchObject({ threshold, generate });
    expect(selection?.distance).toBeCloseTo(value);
    expect(selection?.nearest).toHaveLength(1);
  });

  it.each(["count", "updatedAt"] as const)("invalidates the cached threshold when the set's %s changes", (change) => {
    const candidates = [0, 0.25, 0.5].map(uniformCandidate);
    const router = new DeterministicSemanticAssetRouter(repository(candidates));
    const input = { channelId: "c1", text: "cached", affect: responseAffect(), assetSetUpdatedAt: "2026-10-15T00:00:00Z" };
    expect(router.route(input)?.threshold).toBeCloseTo(0.25);
    if (change === "count") candidates.push(uniformCandidate(1));
    else candidates[2] = uniformCandidate(1);
    expect(router.route({ ...input, ...(change === "updatedAt" ? { assetSetUpdatedAt: "2026-10-15T00:00:01Z" } : {}) })?.threshold)
      .toBeCloseTo(change === "count" ? 0.5 : 0.75);
  });

  it("reuses the leave-one-out threshold for an unchanged set revision", () => {
    const distance = vi.spyOn(affectSpace, "weightedAffectDistance");
    const router = new DeterministicSemanticAssetRouter(repository([0, 0.25, 0.5].map(uniformCandidate)));
    const input = { channelId: "c1", text: "cached", affect: responseAffect(), assetSetUpdatedAt: "revision" };
    router.route(input);
    distance.mockClear();
    router.route(input);
    // Only the three query distances, not six more leave-one-out distances.
    expect(distance).toHaveBeenCalledTimes(3);
  });

  it("ranks the complete mapped set in AffectSpaceV2 without a coarse-emotion filter", () => {
    const angry = visualAffect({ anger: 0.9, irritation: 0.8, playfulness: 0.7 });
    const cheerful = visualAffect({ joy: 0.9, smileIntensity: 0.9 });
    const selection = new DeterministicSemanticAssetRouter(repository([
      candidate("cheerful.png", cheerful, affectVectorFromDimensions(cheerful.dimensions)),
      candidate("playful-angry.png", angry, affectVectorFromDimensions(angry.dimensions), { emotion: "neutral" }),
    ])).route({
      channelId: "channel-1",
      emotion: "happy",
      text: "흥, 그래도 귀엽게 봐줄게 😤",
      affect: responseAffect({ anger: 0.85, irritation: 0.75, playfulness: 0.72 }),
    });
    expect(selection).toMatchObject({ mode: "affect-v2", media: { filename: "playful-angry.png" }, distance: expect.any(Number) });
  });

  it("uses injected randomness when multiple V2 images have the same minimum distance", () => {
    const shared = visualAffect({ affection: 0.8, playfulness: 0.7 });
    const selection = new DeterministicSemanticAssetRouter(repository([
      candidate("a.png", shared, affectVectorFromDimensions(shared.dimensions)),
      candidate("b.png", shared, affectVectorFromDimensions(shared.dimensions)),
    ]), () => 0.99).route({
      channelId: "channel-1",
      emotion: "happy",
      text: "same",
      affect: responseAffect({ affection: 0.8, playfulness: 0.7 }),
    });
    expect(selection).toMatchObject({ mode: "affect-v2", media: { filename: "b.png" }, distance: 0 });
  });

  it("does not partially activate a V2 set", () => {
    const migrated = visualAffect({ joy: 0.8 });
    const selection = new DeterministicSemanticAssetRouter(repository([
      candidate("a-unmigrated.png", null, null),
      candidate("z-migrated.png", migrated, affectVectorFromDimensions(migrated.dimensions)),
    ])).route({
      channelId: "channel-1",
      emotion: "happy",
      text: "happy",
      affect: responseAffect({ joy: 0.8 }),
    });
    expect(selection).toMatchObject({ mode: "legacy-fallback", media: { filename: "a-unmigrated.png" }, distance: null, threshold: null, generate: false, nearest: [] });
  });

  it("ranks only mapped-set and selected-emotion candidates by cosine similarity", () => {
    const libraryTags = tags("double thumbs up", "moonlit library");
    const meadowTags = tags("waving", "sunny meadow");
    const candidates = [
      candidate("z-meadow.png", meadowTags, semanticVectorForTags(meadowTags)),
      candidate("b-library.png", libraryTags, semanticVectorForTags(libraryTags)),
      candidate("a-wrong-set.png", libraryTags, semanticVectorForTags(libraryTags), { assetSetId: "other-set" }),
      candidate("a-wrong-emotion.png", libraryTags, semanticVectorForTags(libraryTags), { emotion: "sorry" }),
    ];

    const selection = new DeterministicSemanticAssetRouter(repository(candidates)).route({
      channelId: "channel-1",
      emotion: "happy",
      text: "A bright smile in the moonlit library!",
    });

    expect(selection).toMatchObject({ mode: "semantic", media: { filename: "b-library.png" }, score: expect.any(Number) });
  });

  it("uses filename then id as a stable semantic tie-break", () => {
    const sharedTags = tags("waving", "moonlit library");
    const vector = semanticVectorForTags(sharedTags);
    const selection = new DeterministicSemanticAssetRouter(repository([
      candidate("z.png", sharedTags, vector),
      candidate("a.png", sharedTags, vector),
    ])).route({ channelId: "channel-1", emotion: "happy", text: "waving in a moonlit library" });
    expect(selection).toMatchObject({ mode: "semantic", media: { filename: "a.png" } });
  });

  it.each([
    ["missing", null, null],
    ["malformed", { schemaVersion: "wrong" }, [1]],
    ["zero", tags("waving", "moonlit library"), Array.from({ length: SEMANTIC_ASSET_VECTOR_DIMENSIONS }).fill(0)],
  ])("falls back to legacy filename-first selection for %s metadata", (_name, semanticTags, semanticVector) => {
    const selection = new DeterministicSemanticAssetRouter(repository([
      candidate("z.png", semanticTags, semanticVector),
      candidate("a.png", semanticTags, semanticVector),
    ])).route({ channelId: "channel-1", emotion: "happy", text: "waving" });
    expect(selection).toEqual({
      mode: "legacy-fallback",
      score: null,
      threshold: null,
      generate: false,
      nearest: [],
      media: {
        filename: "a.png",
        contentType: "image/png",
        objectUrl: "/static/sets/mapped-set/a.png",
        storageKey: "sets/mapped-set/a.png",
      },
    });
  });

  it("keeps a partially tagged set on the legacy filename-first path", () => {
    const validTags = tags("waving", "moonlit library");
    const selection = new DeterministicSemanticAssetRouter(repository([
      candidate("z-valid.png", validTags, semanticVectorForTags(validTags)),
      candidate("a-missing.png", null, null),
    ])).route({ channelId: "channel-1", emotion: "happy", text: "waving in a moonlit library" });
    expect(selection).toMatchObject({ mode: "legacy-fallback", media: { filename: "a-missing.png" }, score: null });
  });

  it("returns no asset when the channel has no enabled mapped set", () => {
    expect(new DeterministicSemanticAssetRouter(repository([], null)).route({
      channelId: "channel-1",
      emotion: "happy",
      text: "happy",
    })).toBeNull();
  });
});
