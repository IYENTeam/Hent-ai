import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { finalResponseRequestFromBody, finalVerdictForBody } from "./final-response-routes.js";

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

  it("preserves legacy one-image selection and the outward V1 result shape", async () => {
    const db = new ServiceDatabase();
    registerLegacyAsset(db);
    const result = await finalVerdictForBody(db, {
      verify: async (request) => {
        expect(request.finalText).toBe("A calm reply");
        return { emotion: "neutral", confidence: 0.7, reason: "legacy" };
      },
    }, { context: { channelId: "c1", content: "A calm reply MEDIA:/tmp/ignored.png" } });

    expect(result).toEqual({
      verdict: {
        emotion: "neutral",
        confidence: 0.7,
        reason: "legacy",
        media: {
          filename: "neutral.png",
          contentType: "image/png",
          url: "/static/sets/legacy/neutral.png",
          sensitiveMedia: true,
          metadata: { storageKey: "sets/legacy/neutral.png" },
        },
      },
    });
    db.close();
  });
});
