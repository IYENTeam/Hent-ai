import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { runNextGenerationJob } from "./generation-worker.js";

const tinyPngBase64 = Buffer.from("generated png").toString("base64");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hent-gen-worker-"));
}

describe("generation worker runner", () => {
  it("transitions a queued job to succeeded with mocked provider result", async () => {
    const db = new ServiceDatabase();
    try {
      const job = db.createGenerationJob({ prompt: "mock only" });
      const result = await runNextGenerationJob(db, { generate: async (request) => ({ imageUrl: "/static/generated.png", request }) });

      expect(result).toMatchObject({
        id: job.id,
        status: "succeeded",
        result: { imageUrl: "/static/generated.png", request: { prompt: "mock only" } },
        error: null,
      });
      expect(db.getGenerationJob(job.id)).toMatchObject({ status: "succeeded", result: { imageUrl: "/static/generated.png" }, error: null });
    } finally {
      db.close();
    }
  });

  it("persists generated image bytes as static assets when an asset root is provided", async () => {
    const root = tempDir();
    const db = new ServiceDatabase();
    try {
      const job = db.createGenerationJob({ prompt: "make sorry", assetSetId: "gothic-v1", emotion: "sorry", filename: "sorry.png" });
      const result = await runNextGenerationJob(db, {
        generate: async () => ({ dataBase64: tinyPngBase64, contentType: "image/png", metadata: { provider: "mock" } }),
      }, { assetRoot: root });

      expect(result).toMatchObject({
        id: job.id,
        status: "succeeded",
        result: {
          asset: { assetSetId: "gothic-v1", emotion: "sorry", filename: "sorry.png" },
          media: { contentType: "image/png", sizeBytes: Buffer.from("generated png").length },
        },
        error: null,
      });
      expect(JSON.stringify(result?.result)).not.toContain(tinyPngBase64);
      const media = (result?.result as { media: { storageKey: string; url: string } }).media;
      expect(media.storageKey).toMatch(new RegExp(`^generated/gothic-v1/sorry/${job.id}-sorry\\.png$`));
      expect(media.url).toBe(`/static/${media.storageKey}`);
      expect(existsSync(join(root, media.storageKey))).toBe(true);
      expect(readFileSync(join(root, media.storageKey))).toEqual(Buffer.from("generated png"));
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE asset_set_id = 'gothic-v1' AND emotion = 'sorry'").get()).toEqual({ count: 1 });
      expect(db.db.prepare("SELECT provenance, object_url FROM storage_objects WHERE storage_key = ?").get(media.storageKey)).toMatchObject({ provenance: "generated", object_url: media.url });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("transitions a queued job to failed with provider error", async () => {
    const db = new ServiceDatabase();
    try {
      const job = db.createGenerationJob({ prompt: "fail" });
      const result = await runNextGenerationJob(db, { generate: async () => { throw new Error("provider failed"); } });

      expect(result).toMatchObject({ id: job.id, status: "failed", result: null, error: "provider failed" });
      expect(db.getGenerationJob(job.id)).toMatchObject({ status: "failed", result: null, error: "provider failed" });
    } finally {
      db.close();
    }
  });

  it("returns null without mutation when no queued job exists", async () => {
    const db = new ServiceDatabase();
    try {
      expect(await runNextGenerationJob(db, { generate: async () => { throw new Error("should not run"); } })).toBeNull();
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
