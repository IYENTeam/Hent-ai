import { describe, expect, it, vi } from "vitest";
import { ServiceDatabase } from "./db.js";
import { createFinalResponseUseCase } from "./final-response-use-case.js";
import type { SemanticAssetRouteInput, SemanticAssetRouter } from "./semantic-assets/ports.js";
import { AFFECT_DIMENSIONS, AFFECT_SPACE_VERSION, RESPONSE_AFFECT_SCHEMA_VERSION, type AffectDimensionsV2 } from "../../shared/affect.js";

const routedMedia = {
  filename: "semantic-neutral.png",
  contentType: "image/png",
  objectUrl: "/static/sets/set/semantic-neutral.png",
  storageKey: "sets/set/semantic-neutral.png",
} as const;

function recordingRouter(events: string[], inputs: SemanticAssetRouteInput[]): SemanticAssetRouter {
  return {
    route(input) {
      events.push("router");
      inputs.push(input);
      return { media: routedMedia, mode: "semantic", score: 0.9 };
    },
  };
}

describe("final-response application use case", () => {
  it("routes an authenticated embedded affect vector without a second verifier call", async () => {
    const db = new ServiceDatabase();
    const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, key === "joy" ? 0.88 : 0.12])) as AffectDimensionsV2;
    const affect = {
      schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions,
      confidence: 0.93,
    } as const;
    const verify = vi.fn(async () => { throw new Error("must not run"); });
    const inputs: SemanticAssetRouteInput[] = [];
    const useCase = createFinalResponseUseCase({ db, verifier: { verify }, assetRouter: recordingRouter([], inputs) });

    await expect(useCase.execute({ channelId: "c1", finalText: "좋아", validEmotions: ["happy"], responseAffect: affect }))
      .resolves.toMatchObject({ verdict: { affect, media: { filename: "semantic-neutral.png" } } });
    expect(verify).not.toHaveBeenCalled();
    expect(inputs).toEqual([{ channelId: "c1", text: "좋아", affect }]);
    db.close();
  });

  it("passes a cached or fresh ResponseAffectV2 vector to the router", async () => {
    const db = new ServiceDatabase();
    const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, key === "anger" ? 0.8 : 0.1])) as AffectDimensionsV2;
    const affect = {
      schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions,
      confidence: 0.92,
    } as const;
    const inputs: SemanticAssetRouteInput[] = [];
    const useCase = createFinalResponseUseCase({
      db,
      verifier: { verify: async () => ({ emotion: "happy", affect }) },
      assetRouter: recordingRouter([], inputs),
    });
    const request = { channelId: "c1", finalText: "흥 😤", validEmotions: ["happy"] } as const;
    await useCase.execute(request);
    await useCase.execute(request);
    expect(inputs).toEqual([
      { channelId: "c1", emotion: "happy", text: "흥 😤", affect },
      { channelId: "c1", emotion: "happy", text: "흥 😤", affect },
    ]);
    db.close();
  });

  it("routes a complete affect vector even when no coarse emotion fits", async () => {
    const db = new ServiceDatabase();
    const dimensions = Object.fromEntries(AFFECT_DIMENSIONS.map((key) => [key, key === "anger" ? 0.9 : 0.1])) as AffectDimensionsV2;
    const affect = {
      schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions,
      confidence: 0.94,
    } as const;
    const inputs: SemanticAssetRouteInput[] = [];
    const useCase = createFinalResponseUseCase({
      db,
      verifier: { verify: async () => ({ affect, reason: "anger has no legacy coarse label" }) },
      assetRouter: recordingRouter([], inputs),
    });

    await expect(useCase.execute({ channelId: "c1", finalText: "화가 난다", validEmotions: ["happy"] }))
      .resolves.toMatchObject({ verdict: { affect, media: { filename: "semantic-neutral.png" } } });
    expect(inputs).toEqual([{ channelId: "c1", text: "화가 난다", affect }]);
    db.close();
  });

  it("validates the coarse verifier judgment before routing the sanitized final text", async () => {
    const db = new ServiceDatabase();
    const events: string[] = [];
    const inputs: SemanticAssetRouteInput[] = [];
    const useCase = createFinalResponseUseCase({
      db,
      verifier: { verify: async (request) => {
        events.push("verifier");
        expect(request).toEqual({ channelId: "c1", finalText: "Task complete", validEmotions: ["neutral"] });
        return { emotion: " Neutral ", confidence: 0.91, reason: "coarse" };
      } },
      assetRouter: recordingRouter(events, inputs),
    });

    await expect(useCase.execute({ channelId: "c1", finalText: "Task complete", validEmotions: ["neutral"] })).resolves.toEqual({
      verdict: {
        emotion: "neutral",
        confidence: 0.91,
        reason: "coarse",
        media: {
          filename: "semantic-neutral.png",
          contentType: "image/png",
          url: "/static/sets/set/semantic-neutral.png",
          sensitiveMedia: true,
          metadata: { storageKey: "sets/set/semantic-neutral.png" },
        },
      },
    });
    expect(events).toEqual(["verifier", "router"]);
    expect(inputs).toEqual([{ channelId: "c1", emotion: "neutral", text: "Task complete" }]);
    db.close();
  });

  it("never invokes semantic routing for invalid or non-canonical coarse emotions", async () => {
    const db = new ServiceDatabase();
    let routes = 0;
    let verifierCalls = 0;
    const assetRouter: SemanticAssetRouter = { route: () => { routes += 1; return null; } };

    const invalidJudgment = createFinalResponseUseCase({
      db,
      verifier: { verify: async () => { verifierCalls += 1; return { emotion: "happy" }; } },
      assetRouter,
    });
    await expect(invalidJudgment.execute({ channelId: "c1", finalText: "hello", validEmotions: ["neutral"] }))
      .resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "verifier_emotion_invalid" }] });

    const invalidRequest = createFinalResponseUseCase({
      db,
      verifier: { verify: async () => { verifierCalls += 1; return { emotion: "invented" }; } },
      assetRouter,
    });
    await expect(invalidRequest.execute({ channelId: "c1", finalText: "hello", validEmotions: ["invented"] }))
      .resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "no_final_text_or_valid_emotions" }] });

    expect(verifierCalls).toBe(1);
    expect(routes).toBe(0);
    db.close();
  });

  it("reuses the coarse verifier cache while rerouting each request from its final text", async () => {
    const db = new ServiceDatabase();
    let verifierCalls = 0;
    const routedInputs: SemanticAssetRouteInput[] = [];
    const useCase = createFinalResponseUseCase({
      db,
      verifier: { verify: async () => {
        verifierCalls += 1;
        return { emotion: "neutral", confidence: 0.8, reason: "cached" };
      } },
      assetRouter: recordingRouter([], routedInputs),
    });
    const request = { channelId: "c1", finalText: "same semantic text", validEmotions: ["neutral"] } as const;

    await useCase.execute(request);
    await useCase.execute(request);

    expect(verifierCalls).toBe(1);
    expect(routedInputs).toEqual([
      { channelId: "c1", emotion: "neutral", text: "same semantic text" },
      { channelId: "c1", emotion: "neutral", text: "same semantic text" },
    ]);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 1 });
    db.close();
  });
});
