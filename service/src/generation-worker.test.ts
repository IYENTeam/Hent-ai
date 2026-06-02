import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { runNextGenerationJob } from "./generation-worker.js";

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
