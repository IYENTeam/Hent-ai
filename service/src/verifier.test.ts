import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { createHentAiServer, listen } from "./server.js";
import type { FinalResponseVerifier } from "./verifier.js";
import { createRemoteFinalResponseVerifier, createOpenAiChatCompletionsFinalResponseVerifier, loadVerifierProviderConfigFromEnv, normalizeVerifierJudgment } from "./verifier.js";

const token = "test-token";

function seedNeutralAsset(db: ServiceDatabase): void {
  db.upsertAssetSet({ id: "set", name: "Set" });
  const storageObjectId = db.upsertStorageObject({
    storageKey: "sets/set/neutral.png",
    objectUrl: "/static/sets/set/neutral.png",
    contentHash: "hash",
    contentType: "image/png",
    sizeBytes: 1,
    provenance: "test",
  });
  db.upsertAsset({ id: "asset-neutral", assetSetId: "set", emotion: "neutral", filename: "neutral.png", storageObjectId, contentHash: "hash" });
  db.setChannelMapping("c1", { enabled: true, assetSetId: "set" });
}

async function withServer<T>(db: ServiceDatabase, verifier: FinalResponseVerifier, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const binding = await listen(createHentAiServer({ db, token, verifier }));
  try {
    return await fn(binding.url);
  } finally {
    await binding.close();
    db.close();
  }
}

async function requestVerdict(baseUrl: string, content: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/v1/final-response/verdict`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ context: { channelId: "c1", content } }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("final-response verifier boundary", () => {
  it("uses external verifier judgment, keeps service media mapping, and reuses cache", async () => {
    const db = new ServiceDatabase();
    seedNeutralAsset(db);
    let calls = 0;
    const verifier: FinalResponseVerifier = {
      verify: async () => {
        calls += 1;
        return { emotion: "neutral", confidence: 0.88, reason: "remote_verifier" };
      },
    };

    await withServer(db, verifier, async (baseUrl) => {
      await expect(requestVerdict(baseUrl, "hello"))
        .resolves.toMatchObject({ verdict: { emotion: "neutral", confidence: 0.88, reason: "remote_verifier", media: { url: "/static/sets/set/neutral.png" } } });
      await expect(requestVerdict(baseUrl, "hello"))
        .resolves.toMatchObject({ verdict: { emotion: "neutral", reason: "remote_verifier" } });
      expect(calls).toBe(1);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 1 });
    });
  });

  it("returns null and caches completed no-verdict, unknown, and invalid judgments", async () => {
    const db = new ServiceDatabase();
    seedNeutralAsset(db);
    const responses: unknown[] = [null, { emotion: "happy", confidence: 0.5 }, { confidence: 0.5 }];
    const verifier: FinalResponseVerifier = { verify: async () => responses.shift() as never };

    await withServer(db, verifier, async (baseUrl) => {
      await expect(requestVerdict(baseUrl, "no match")).resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "verifier_emotion_invalid" }] });
      await expect(requestVerdict(baseUrl, "unknown emotion")).resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "verifier_emotion_invalid" }] });
      await expect(requestVerdict(baseUrl, "invalid shape")).resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "verifier_emotion_invalid" }] });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 3 });
    });
  });

  it("does not cache transient verifier errors or fall back to deterministic local matching", async () => {
    const db = new ServiceDatabase();
    seedNeutralAsset(db);
    let calls = 0;
    const verifier: FinalResponseVerifier = {
      verify: async () => {
        calls += 1;
        throw new Error("remote timeout");
      },
    };

    await withServer(db, verifier, async (baseUrl) => {
      await expect(requestVerdict(baseUrl, "neutral text should not be locally matched")).resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "verifier_error" }] });
      await expect(requestVerdict(baseUrl, "neutral text should not be locally matched")).resolves.toEqual({ verdict: null, diagnostics: [{ skipped: true, reason: "verifier_error" }] });
      expect(calls).toBe(2);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache").get()).toEqual({ count: 0 });
    });
  });
});

describe("remote verifier adapter", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  });

  it("normalizes supported judgment response shapes", () => {
    expect(normalizeVerifierJudgment({ verdict: { emotion: " Neutral ", confidence: 0.7, reason: "ok" } }))
      .toEqual({ emotion: "neutral", confidence: 0.7, reason: "ok" });
    expect(normalizeVerifierJudgment({ judgment: { emotion: "happy" } })).toEqual({ emotion: "happy" });
    expect(normalizeVerifierJudgment({ confidence: 0.2 })).toBeNull();
    expect(normalizeVerifierJudgment({
      choices: [{ message: { content: "{\"emotion\":\"neutral\",\"confidence\":0.9,\"reason\":\"chat-completions\"}" } }],
    })).toEqual({ emotion: "neutral", confidence: 0.9, reason: "chat-completions" });
  });

  it("keeps the generic remote verifier request shape for existing deployments", async () => {
    let auth: string | undefined;
    let body: unknown;
    const server = createServer(async (req, res) => {
      auth = req.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ verdict: { emotion: "Neutral", confidence: 0.91, reason: "remote" } }));
    });
    servers.push(server);
    const binding = await listen(server);
    const verifier = createRemoteFinalResponseVerifier({ url: binding.url, token: "secret" });

    expect(await verifier.verify({
      channelId: "c1",
      finalText: "hello",
      validEmotions: ["neutral"],
      metadata: { source: "test" },
    })).toEqual({ emotion: "neutral", confidence: 0.91, reason: "remote" });

    expect(auth).toBe("Bearer secret");
    expect(body).toEqual({
      context: {
        channelId: "c1",
        content: "hello",
        validEmotions: ["neutral"],
        metadata: { source: "test" },
      },
    });
  });

  it("builds default chat-completions OpenAI-format requests", async () => {
    let body: unknown;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"emotion\":\"neutral\",\"confidence\":0.92,\"reason\":\"chat-completions\"}" } }] }));
    });
    servers.push(server);
    const binding = await listen(server);
    const verifier = createOpenAiChatCompletionsFinalResponseVerifier({
      providerKind: "openai-chat-completions",
      endpoint: `${binding.url}/v1/chat/completions`,
      token: "secret",
      modelOrRoute: "model-fast",
      timeoutMs: 1_000,
      extraBody: { temperature: 0 },
    });

    expect(await verifier.verify({
      channelId: "c1",
      finalText: "hello",
      validEmotions: ["neutral"],
      metadata: { source: "test" },
    })).toEqual({ emotion: "neutral", confidence: 0.92, reason: "chat-completions" });

    expect(body).toMatchObject({
      model: "model-fast",
      temperature: 0,
      messages: [
        { role: "system" },
        { role: "user" },
      ],
    });
    const userMessage = (body as { messages: Array<{ content: string }> }).messages[1];
    expect(JSON.parse(userMessage.content)).toEqual({
      finalText: "hello",
      validEmotions: ["neutral"],
      channelId: "c1",
      metadata: { source: "test" },
    });
  });

  it("builds chat-completions requests with explicit provider config and mapped body", async () => {
    let auth: string | undefined;
    let extraHeader: string | undefined;
    let requestUrl: string | undefined;
    let body: unknown;
    const server = createServer(async (req, res) => {
      auth = req.headers.authorization;
      extraHeader = req.headers["x-provider-route"] as string | undefined;
      requestUrl = req.url;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ verdict: { emotion: "Neutral", confidence: 0.91, reason: "remote" } }));
    });
    servers.push(server);
    const binding = await listen(server);
    const verifier = createOpenAiChatCompletionsFinalResponseVerifier({
      providerKind: "openai-chat-completions",
      endpoint: `${binding.url}/verify?route=provider`,
      token: "secret",
      modelOrRoute: "model-or-route",
      timeoutMs: 1_000,
      extraHeaders: { "x-provider-route": "final-response", authorization: "Bearer wrong" },
      extraBody: { temperature: 0 },
      bodyMapping: {
        modelOrRouteField: "route",
        requestField: "request",
        finalTextField: "content",
        validEmotionsField: "emotions",
      },
    });

    expect(await verifier.verify({
      channelId: "c1",
      finalText: "hello",
      validEmotions: ["neutral"],
      metadata: { source: "test" },
    })).toEqual({ emotion: "neutral", confidence: 0.91, reason: "remote" });

    expect(requestUrl).toBe("/verify?route=provider");
    expect(auth).toBe("Bearer secret");
    expect(extraHeader).toBe("final-response");
    expect(body).toEqual({
      temperature: 0,
      route: "model-or-route",
      request: {
        content: "hello",
        emotions: ["neutral"],
        channelId: "c1",
        metadata: { source: "test" },
      },
    });
  });

  it("loads chat-completions provider config from env and fails closed on missing secrets", () => {
    expect(loadVerifierProviderConfigFromEnv({
      HENT_AI_VERIFIER_PROVIDER_KIND: "openai-chat-completions",
      HENT_AI_VERIFIER_ENDPOINT: "https://verifier.example/verify",
      HENT_AI_VERIFIER_TOKEN: "secret",
      HENT_AI_VERIFIER_MODEL_OR_ROUTE: "model-or-route",
      HENT_AI_VERIFIER_TIMEOUT_MS: "2500",
      HENT_AI_VERIFIER_EXTRA_HEADERS_JSON: JSON.stringify({ "x-provider-route": "final-response" }),
      HENT_AI_VERIFIER_EXTRA_BODY_JSON: JSON.stringify({ temperature: 0 }),
    })).toMatchObject({
      providerKind: "openai-chat-completions",
      endpoint: "https://verifier.example/verify",
      token: "secret",
      modelOrRoute: "model-or-route",
      timeoutMs: 2500,
      extraHeaders: { "x-provider-route": "final-response" },
      extraBody: { temperature: 0 },
    });

    expect(() => loadVerifierProviderConfigFromEnv({
      HENT_AI_VERIFIER_PROVIDER_KIND: "openai-chat-completions",
      HENT_AI_VERIFIER_ENDPOINT: "https://verifier.example/verify",
      HENT_AI_VERIFIER_MODEL_OR_ROUTE: "model-or-route",
    })).toThrow(/HENT_AI_VERIFIER_TOKEN/);
  });

  it("keeps the vm4 closedrouter deployment provider kind compatible", () => {
    expect(loadVerifierProviderConfigFromEnv({
      HENT_AI_VERIFIER_PROVIDER_KIND: "vm4-closedrouter",
      HENT_AI_VERIFIER_ENDPOINT: "https://verifier.example/v1/chat/completions",
      HENT_AI_VERIFIER_TOKEN: "secret",
      HENT_AI_VERIFIER_MODEL_OR_ROUTE: "gpt-5.5",
    })).toMatchObject({
      providerKind: "openai-chat-completions",
      endpoint: "https://verifier.example/v1/chat/completions",
      token: "secret",
      modelOrRoute: "gpt-5.5",
    });
  });

  it("aborts chat-completions requests at the configured timeout", async () => {
    let aborted = false;
    const verifier = createOpenAiChatCompletionsFinalResponseVerifier({
      providerKind: "openai-chat-completions",
      endpoint: "https://verifier.example/verify",
      token: "secret",
      modelOrRoute: "model-or-route",
      timeoutMs: 1,
      fetchImpl: ((_, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as typeof fetch,
    });

    await expect(verifier.verify({ finalText: "hello", validEmotions: ["neutral"] })).rejects.toThrow("aborted");
    expect(aborted).toBe(true);
  });
});
