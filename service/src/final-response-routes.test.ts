import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { finalResponseRequestFromBody, finalVerdictForBody } from "./final-response-routes.js";
import { responseAffect } from "./service-test-helpers.js";
import { AFFECT_DIMENSIONS, affectVectorFromDimensions, type AffectDimensionsV2 } from "../../shared/affect.js";
import { ServiceDatabaseSemanticAssetRepository } from "./semantic-assets/db-repository.js";
import { DeterministicSemanticAssetRouter } from "./semantic-assets/router.js";

function registerLegacyAsset(db: ServiceDatabase): void {
  db.upsertAssetSet({ id: "legacy", name: "Legacy" });
  const storageObjectId = db.upsertStorageObject({
    storageKey: "sets/legacy/neutral.png",
    objectUrl: "/static/sets/legacy/neutral.png",
    contentHash: "legacy-hash",
    contentType: "image/png",
    sizeBytes: 1,
    provenance: "test",
  });
  db.upsertAsset({ id: "legacy-neutral", assetSetId: "legacy", emotion: "neutral", filename: "neutral.png", storageObjectId, contentHash: "legacy-hash" });
  db.setChannelMapping("c1", { enabled: true, assetSetId: "legacy" });
}

describe("final-response route adapter", () => {
  it("normalizes hook body aliases and removes untrusted MEDIA directives", () => {
    expect(finalResponseRequestFromBody({
      context: {
        channelId: " c1 ",
        content: "Task complete MEDIA:`/tmp/not-owned.png` thanks",
        validEmotions: [" Neutral ", "neutral"],
      },
    })).toEqual({ channelId: "c1", finalText: "Task complete thanks", validEmotions: ["neutral"] });
  });

  it("falls back to legacy one-image selection for an untagged set and keeps the outward V1 result shape", async () => {
    const db = new ServiceDatabase();
    registerLegacyAsset(db);
    const affect = responseAffect();
    const result = await finalVerdictForBody(db, { context: { channelId: "c1", content: "A calm reply MEDIA:/tmp/ignored.png", responseAffect: affect } });

    expect(result).toEqual({
      verdict: {
        affect,
        routing: { mode: "legacy-fallback", distance: null, threshold: null, generate: false, nearest: [] },
        media: {
          filename: "neutral.png",
          contentType: "image/png",
          url: "/static/sets/legacy/neutral.png",
          sensitiveMedia: false,
          metadata: { storageKey: "sets/legacy/neutral.png" },
        },
      },
    });
    db.close();
  });

  it("returns fit references and refreshes the threshold after a stored set update", async () => {
    const db = new ServiceDatabase();
    registerLegacyAsset(db);
    for (const value of [0, 0.25, 0.5]) {
      const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, value])) as AffectDimensionsV2;
      const storageObjectId = db.upsertStorageObject({
        storageKey: `sets/fit/${value}.png`, objectUrl: `/static/sets/fit/${value}.png`,
        contentHash: `${value}`, contentType: "image/png", sizeBytes: 1, provenance: "test",
      });
      db.upsertAsset({
        id: `${value}`, assetSetId: "legacy", emotion: "neutral", filename: `${value}.png`, storageObjectId, contentHash: `${value}`,
        semanticTags: { schemaVersion: "VisualAffectV2", affectSpaceVersion: "AffectSpaceV2", dimensions, confidence: 1, evidence: ["fixture"] },
        semanticVector: affectVectorFromDimensions(dimensions),
      });
    }
    db.db.prepare("DELETE FROM assets WHERE id = 'legacy-neutral'").run();
    db.db.prepare("UPDATE assets SET updated_at = '2026-10-15T00:00:00Z'").run();
    const router = new DeterministicSemanticAssetRouter(new ServiceDatabaseSemanticAssetRepository(db));
    const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, 0])) as AffectDimensionsV2;
    const body = { channelId: "c1", text: "fit", responseAffect: responseAffect(dimensions) };
    const first = await finalVerdictForBody(db, body, router);
    expect(first.verdict?.routing?.threshold).toBeCloseTo(0.25);
    expect(first.verdict?.routing).toMatchObject({
      mode: "affect-v2", distance: 0, generate: false,
      nearest: [
        { url: "/static/sets/fit/0.png", filename: "0.png", distance: 0 },
        { url: "/static/sets/fit/0.25.png", filename: "0.25.png" },
        { url: "/static/sets/fit/0.5.png", filename: "0.5.png" },
      ],
    });
    // Move the middle point onto the first: count stays fixed, max updated_at changes.
    db.db.prepare(`UPDATE assets SET semantic_tags_json = ?, semantic_vector_json = ?, updated_at = ?
      WHERE id = '0.25'`).run(
      JSON.stringify({ schemaVersion: "VisualAffectV2", affectSpaceVersion: "AffectSpaceV2", dimensions, confidence: 1, evidence: ["updated"] }),
      JSON.stringify(affectVectorFromDimensions(dimensions)), "2026-10-15T00:00:01Z",
    );
    const updated = await finalVerdictForBody(db, body, router);
    expect(updated.verdict?.routing?.threshold).toBeCloseTo(0.5);
    db.close();
  });
});
