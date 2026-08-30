import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { request, withServer } from "./service-test-helpers.js";
import type { VerifierRequest } from "./verifier.js";

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

  it.each(mediaSanitizationCases)("strips MEDIA directives before verifier input for $name", async ({ body, expectedFinalText }) => {
    const db = new ServiceDatabase();
    registerNeutralAsset(db);
    const requests: VerifierRequest[] = [];

    await withServer(db, async (baseUrl) => {
      const response = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify(body) });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ verdict: { emotion: "neutral", media: { filename: "neutral.png" } } });
      expect(requests.map((verifierRequest) => verifierRequest.finalText)).toEqual([expectedFinalText]);
    }, { verifier: { verify: async (verifierRequest) => {
      requests.push(verifierRequest);
      return { emotion: "neutral", confidence: 0.9, reason: "sanitized" };
    } } });
  });

  it("skips media-only final-response input without calling the verifier", async () => {
    const db = new ServiceDatabase();
    registerNeutralAsset(db);
    const requests: VerifierRequest[] = [];

    await withServer(db, async (baseUrl) => {
      const response = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "c1", content: "MEDIA:/tmp/not-owned.png", validEmotions: ["neutral"] } }) });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "no_final_text_or_valid_emotions" }] });
      expect(requests).toEqual([]);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 0 });
    }, { verifier: { verify: async (verifierRequest) => {
      requests.push(verifierRequest);
      return { emotion: "neutral" };
    } } });
  });

  it("reuses one verifier call and cache row for sanitized-equivalent unsafe and safe prose", async () => {
    const db = new ServiceDatabase();
    registerNeutralAsset(db);
    const requests: VerifierRequest[] = [];

    await withServer(db, async (baseUrl) => {
      const unsafe = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "c1", content: "Task complete MEDIA:/tmp/not-owned.png", validEmotions: ["neutral"] } }) });
      const safe = await request(baseUrl, "/v1/final-response/verdict", { method: "POST", body: JSON.stringify({ context: { channelId: "c1", content: "Task complete", validEmotions: ["neutral"] } }) });

      expect(unsafe.status).toBe(200);
      expect(safe.status).toBe(200);
      expect(requests.map((verifierRequest) => verifierRequest.finalText)).toEqual(["Task complete"]);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 1 });
    }, { verifier: { verify: async (verifierRequest) => {
      requests.push(verifierRequest);
      return { emotion: "neutral", confidence: 0.9, reason: "cached_sanitized" };
    } } });
  });
});
