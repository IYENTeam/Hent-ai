import { describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { createFinalResponseUseCase } from "./final-response-use-case.js";
import type { SemanticAssetRouteInput, SemanticAssetRouter } from "./semantic-assets/ports.js";
import { responseAffect } from "./service-test-helpers.js";

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
  it("routes the request's affect vector", async () => {
    const db = new ServiceDatabase();
    const affect = responseAffect({ joy: 0.88 });
    const inputs: SemanticAssetRouteInput[] = [];
    const useCase = createFinalResponseUseCase({ db, assetRouter: recordingRouter([], inputs) });

    await expect(useCase.execute({ channelId: "c1", finalText: "좋아", validEmotions: ["happy"], responseAffect: affect })).resolves.toEqual({
      verdict: {
        affect,
        routing: { mode: "semantic", distance: null, threshold: null, generate: false, nearest: [] },
        media: {
          filename: "semantic-neutral.png",
          contentType: "image/png",
          url: "/static/sets/set/semantic-neutral.png",
          sensitiveMedia: false,
          metadata: { storageKey: "sets/set/semantic-neutral.png" },
        },
      },
    });
    expect(inputs).toEqual([{ channelId: "c1", text: "좋아", affect }]);
    db.close();
  });

  it("skips a request without responseAffect before routing", async () => {
    const db = new ServiceDatabase();
    const events: string[] = [];
    const useCase = createFinalResponseUseCase({ db, assetRouter: recordingRouter(events, []) });

    await expect(useCase.execute({ channelId: "c1", finalText: "hello", validEmotions: ["neutral"] }))
      .resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "missing_response_affect" }] });
    expect(events).toEqual([]);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 0 });
    db.close();
  });

  it("never invokes routing for non-canonical valid emotions", async () => {
    const db = new ServiceDatabase();
    let routes = 0;
    const assetRouter: SemanticAssetRouter = { route: () => { routes += 1; return null; } };
    const useCase = createFinalResponseUseCase({ db, assetRouter });

    await expect(useCase.execute({ channelId: "c1", finalText: "hello", validEmotions: ["invented"], responseAffect: responseAffect() }))
      .resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "no_final_text_or_valid_emotions" }] });
    expect(routes).toBe(0);
    db.close();
  });

  it("caches the routed verdict while rerouting each request from its final text", async () => {
    const db = new ServiceDatabase();
    const affect = responseAffect({ anger: 0.8 });
    const routedInputs: SemanticAssetRouteInput[] = [];
    const useCase = createFinalResponseUseCase({ db, assetRouter: recordingRouter([], routedInputs) });
    const request = { channelId: "c1", finalText: "흥 😤", validEmotions: ["happy"], responseAffect: affect } as const;

    await useCase.execute(request);
    await useCase.execute(request);

    expect(routedInputs).toEqual([
      { channelId: "c1", text: "흥 😤", affect },
      { channelId: "c1", text: "흥 😤", affect },
    ]);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 1 });
    db.close();
  });

  it("refreshes fit fields and reference URLs even on a cached verdict", async () => {
    const db = new ServiceDatabase();
    let distance = 0.5;
    const useCase = createFinalResponseUseCase({ db, assetRouter: {
      route: () => ({
        media: routedMedia, mode: "affect-v2", score: 1 - distance, distance,
        threshold: 0.25, generate: distance > 0.25, nearest: [{ media: routedMedia, distance }],
      }),
    } });
    const request = { channelId: "c1", finalText: "fit", validEmotions: ["happy"], responseAffect: responseAffect() };
    const first = await useCase.execute(request);
    distance = 0;
    const cached = await useCase.execute(request);
    expect(first.verdict?.routing).toEqual({
      mode: "affect-v2", distance: 0.5, threshold: 0.25, generate: true,
      nearest: [{ url: routedMedia.objectUrl, filename: routedMedia.filename, distance: 0.5 }],
    });
    expect(cached.verdict?.routing).toEqual({
      mode: "affect-v2", distance: 0, threshold: 0.25, generate: false,
      nearest: [{ url: routedMedia.objectUrl, filename: routedMedia.filename, distance: 0 }],
    });
    db.close();
  });
});
