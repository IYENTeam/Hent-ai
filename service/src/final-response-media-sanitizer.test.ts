import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { request, responseAffect, withServer } from "./service-test-helpers.js";

function registerNeutralAsset(db: ServiceDatabase): void {
  db.upsertAssetSet({ id: "set", name: "Set" });
  const storageObjectId = db.upsertStorageObject({
    storageKey: "sets/set/neutral.png",
    objectUrl: "/static/sets/set/neutral.png",
    contentHash: "neutral-hash",
    contentType: "image/png",
    sizeBytes: 1,
    provenance: "test",
  });
  db.upsertAsset({ id: "asset-neutral", assetSetId: "set", emotion: "neutral", filename: "neutral.png", storageObjectId, contentHash: "neutral-hash" });
  db.setChannelMapping("c1", { enabled: true, assetSetId: "set" });
}

const affect = responseAffect();

function withAffect(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, responseAffect: affect };
}

function verdictCacheRows(db: ServiceDatabase): unknown {
  return db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get();
}

describe("final-response MEDIA sanitizer", () => {
  const mediaSanitizationCases = [
    {
      name: "top-level finalText line-form directive",
      body: { channelId: "c1", finalText: "Task complete\nMEDIA:/tmp/not-owned.png", validEmotions: ["neutral"] },
      expectedFinalText: "Task complete",
    },
    {
      name: "top-level content inline directive",
      body: { channelId: "c1", content: "Task complete MEDIA:/tmp/not-owned.png thanks", validEmotions: ["neutral"] },
      expectedFinalText: "Task complete thanks",
    },
    {
      name: "top-level text quoted directive",
      body: { channelId: "c1", text: "Task complete MEDIA:\"/tmp/not owned.png\" thanks", validEmotions: ["neutral"] },
      expectedFinalText: "Task complete thanks",
    },
    {
      name: "context finalText backticked directive",
      body: { context: { channelId: "c1", finalText: "Task complete MEDIA:`/tmp/not-owned.png` thanks", validEmotions: ["neutral"] } },
      expectedFinalText: "Task complete thanks",
    },
    {
      name: "context content multiple directives",
      body: { context: { channelId: "c1", content: "Task MEDIA:/tmp/a.png complete MEDIA:'/tmp/b.png'", validEmotions: ["neutral"] } },
      expectedFinalText: "Task complete",
    },
    {
      name: "context text line-form directive",
      body: { context: { channelId: "c1", text: "Task complete\nMEDIA:/tmp/not-owned.png", validEmotions: ["neutral"] } },
      expectedFinalText: "Task complete",
    },
  ];

  it.each(mediaSanitizationCases)("strips MEDIA directives before the verdict cache key for $name", async ({ body, expectedFinalText }) => {
    const db = new ServiceDatabase();
    registerNeutralAsset(db);

    await withServer(db, async (baseUrl) => {
      const unsafe = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify(withAffect(body)) });
      expect(unsafe.status).toBe(200);
      expect(await unsafe.json()).toMatchObject({ verdict: { affect, media: { filename: "neutral.png" } } });

      const safe = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify(withAffect({ channelId: "c1", finalText: expectedFinalText, validEmotions: ["neutral"] })) });
      expect(safe.status).toBe(200);
      expect(verdictCacheRows(db)).toEqual({ count: 1 });
    });
  });

  it("skips media-only final-response input without caching", async () => {
    const db = new ServiceDatabase();
    registerNeutralAsset(db);

    await withServer(db, async (baseUrl) => {
      const response = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify(withAffect({ context: { channelId: "c1", content: "MEDIA:/tmp/not-owned.png", validEmotions: ["neutral"] } })) });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "no_final_text_or_valid_emotions" }] });
      expect(verdictCacheRows(db)).toEqual({ count: 0 });
    });
  });
});
