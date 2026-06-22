import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  expandEnvPlaceholder,
  normalizeServiceMedia,
  resolveServiceConfig,
  validateServiceConfig,
} from "./index.js";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

function setup(
  config: unknown = { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250 } },
  options: { supportsReplyPayloadSending?: boolean } = { supportsReplyPayloadSending: true },
) {
  const events = new Map<string, Handler>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = {
    pluginConfig: config,
    logger,
    supportsHook: vi.fn((name: string) => name === "reply_payload_sending" && options.supportsReplyPayloadSending === true),
    on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
  };
  plugin.register(api as any);
  return { api, events, logger };
}

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

function okBytes(bytes: Uint8Array, contentType = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe("Hent-ai service adapter configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("expands token environment placeholders", () => {
    vi.stubEnv("HENT_AI_TOKEN", "from-env");
    expect(expandEnvPlaceholder("${HENT_AI_TOKEN}")).toBe("from-env");
    expect(expandEnvPlaceholder("literal-token")).toBe("literal-token");
  });

  it("uses the hentAiService namespace from plugin config before runtime config", () => {
    const api = {
      pluginConfig: { hentAiService: { url: "https://plugin.test", token: "plugin" } },
      runtime: { config: { current: () => ({ hentAiService: { url: "https://runtime.test", token: "runtime" } }) } },
    };
    expect(resolveServiceConfig(api)?.url).toBe("https://plugin.test");
  });

  it("validates token and HTTPS except localhost", () => {
    expect(validateServiceConfig({ url: "https://hent.test", token: "t" }).ok).toBe(true);
    expect(validateServiceConfig({ url: "http://localhost:8787", token: "t" }).ok).toBe(true);
    expect(validateServiceConfig({ url: "http://hent.test", token: "t" })).toEqual({
      ok: false,
      reason: "hentAiService.url must be HTTPS unless it targets localhost",
    });
    expect(validateServiceConfig({ url: "https://hent.test" })).toEqual({ ok: false, reason: "missing hentAiService.token" });
  });

  it("logs disabled state and registers no hooks when config is missing or invalid", () => {
    const { api, events, logger } = setup({ hentAiService: { url: "http://example.test", token: "secret" } });
    expect(api.on).not.toHaveBeenCalled();
    expect(events.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("hent-ai adapter disabled"));
  });
  it("respects enabled=false without validating service credentials", () => {
    const { api, events, logger } = setup({ enabled: false });
    expect(api.on).not.toHaveBeenCalled();
    expect(events.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith("hent-ai adapter disabled: enabled=false");
  });

  it("registers only the current final reply payload hook when supported", () => {
    const { api, events } = setup();
    expect([...events.keys()]).toEqual(["message_received", "message_sent", "reply_payload_sending"]);
    expect(api.on).not.toHaveBeenCalledWith("pre_reply_media", expect.any(Function), expect.anything());
    expect(api.on).not.toHaveBeenCalledWith("message_sent_media", expect.any(Function), expect.anything());
    expect(api.on).toHaveBeenCalledWith("message_received", expect.any(Function), { name: "hent-ai-service-message-received" });
    expect(api.on).toHaveBeenCalledWith("message_sent", expect.any(Function), { name: "hent-ai-service-watcher" });
    expect(api.on).toHaveBeenCalledWith("reply_payload_sending", expect.any(Function), { name: "hent-ai-final-reply-payload-media" });
  });

  it("defaults to the current final reply payload hook when the host omits the optional supportsHook probe", () => {
    const events = new Map<string, Handler>();
    const api = {
      pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250 } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
    };

    plugin.register(api as any);

    expect([...events.keys()]).toEqual(["message_received", "message_sent", "reply_payload_sending"]);
    expect(api.on).not.toHaveBeenCalledWith("pre_reply_media", expect.any(Function), expect.anything());
    expect(api.on).not.toHaveBeenCalledWith("message_sent_media", expect.any(Function), expect.anything());
    expect(api.on).toHaveBeenCalledWith("message_received", expect.any(Function), { name: "hent-ai-service-message-received" });
    expect(api.on).toHaveBeenCalledWith("message_sent", expect.any(Function), { name: "hent-ai-service-watcher" });
    expect(api.on).toHaveBeenCalledWith("reply_payload_sending", expect.any(Function), { name: "hent-ai-final-reply-payload-media" });
  });

  it("registers no hooks when the host explicitly rejects reply payload support", () => {
    const { api, events, logger } = setup(undefined, { supportsReplyPayloadSending: false });
    expect([...events.keys()]).toEqual([]);
    expect(api.on).not.toHaveBeenCalledWith("pre_reply_media", expect.any(Function), expect.anything());
    expect(api.on).not.toHaveBeenCalledWith("reply_payload_sending", expect.any(Function), expect.anything());
    expect(api.on).not.toHaveBeenCalledWith("message_sent_media", expect.any(Function), expect.anything());
    expect(logger.warn).toHaveBeenCalledWith("hent-ai adapter disabled: reply_payload_sending hook unsupported");
  });

  it("normalizes service url and base64 media into Stage-1 mediaUrl shape", () => {
    expect(normalizeServiceMedia({ url: "https://cdn.test/a.png", caption: "cap", sensitiveMedia: true })).toMatchObject({
      mediaUrl: "https://cdn.test/a.png",
      caption: "cap",
      sensitiveMedia: true,
    });
    expect(normalizeServiceMedia({ dataBase64: "AAAA", contentType: "image/webp" })?.mediaUrl).toBe("data:image/webp;base64,AAAA");
    expect(normalizeServiceMedia({ caption: "no media" })).toBeNull();
  });

  it("ignores block payloads so media is attached only to the final answer", async () => {
    const fetchMock = vi.fn(async () => okJson({
      media: { url: "https://cdn.test/pre.png", caption: "thinking" },
      diagnostics: [{ reason: "selected" }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({ hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 2500 } });

    const result = await events.get("reply_payload_sending")?.({
      kind: "block",
      payload: {
        text: "thinking",
        channelData: { channelPolicy: "service-owned" },
      },
      sessionKey: "s",
      runId: "r",
    }, { channelId: "channel:123", replyToBody: "hello" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("uses hook context when OpenClaw final event omits a direct channel id", async () => {
    const fetchMock = vi.fn(async () => okJson({ verdict: { media: { url: "https://cdn.test/final.png" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({ hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 2500 } });

    await events.get("reply_payload_sending")?.(
      { kind: "final", payload: { text: "done", to: "channel:from-to" }, sessionKey: "s", runId: "r" },
      { conversationId: "channel:from-context", sessionKey: "s", runId: "r", messageId: "m1" },
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context).toMatchObject({
      to: "channel:from-to",
      channelId: "from-context",
      content: "done",
      messageId: "m1",
      sessionKey: "s",
      runId: "r",
    });
  });


  it("calls final-response verdict service for final payloads and attaches verdict media", async () => {
    const fetchMock = vi.fn(async () => okJson({ verdict: { media: { dataBase64: "BBBB", contentType: "image/jpeg" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    const result = await events.get("reply_payload_sending")?.({
      kind: "final",
      payload: {
        text: "done",
        to: "channel:456",
        channelData: { profile: "svc" },
      },
    }, { messageId: "m1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hent.test/v1/final-response/verdict");
    expect(options.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(options.body).context).toMatchObject({ channelId: "456", content: "done", messageId: "m1" });
    expect(result).toEqual({ payload: { text: "done", to: "channel:456", channelData: { profile: "svc" }, mediaUrl: "data:image/jpeg;base64,BBBB" } });
  });

  it("hydrates service-relative media URLs into local media-cache files before OpenClaw delivery", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href === "http://localhost:8787/v1/final-response/verdict") return okJson({ verdict: { media: { url: "/static/sets/gothic-v1/sorry.png", contentType: "image/png" } } });
      if (href === "http://localhost:8787/static/sets/gothic-v1/sorry.png") return okBytes(new Uint8Array([1, 2, 3]), "image/png");
      throw new Error(`unexpected url ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({ hentAiService: { url: "http://localhost:8787", token: "secret", timeoutMs: 250 } });

    const result = await events.get("reply_payload_sending")?.({ kind: "final", payload: { text: "done", to: "channel:456" } }, { messageId: "m1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ payload: { text: "done", to: "channel:456" } });
    const mediaUrl = (result as { payload?: { mediaUrl?: string } }).payload?.mediaUrl;
    expect(mediaUrl).toContain(".openclaw/media/hent-ai-service-adapter/");
    expect(readFileSync(mediaUrl!)).toEqual(Buffer.from([1, 2, 3]));
  });

  it.each([
    ["null", null],
    ["malformed", { verdict: { media: { caption: "missing url" } } }],
  ])("skips final media on %s service response", async (_name, payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson(payload)));
    const { events, logger } = setup();
    const result = await events.get("reply_payload_sending")?.({ kind: "final", payload: { text: "y", to: "channel:1" } }, { messageId: "m" });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("skipping media"));
  });

  it("skips media on service HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const { events } = setup();
    await expect(events.get("reply_payload_sending")?.({ kind: "final", payload: { text: "x", to: "channel:1" } }, { messageId: "m" })).resolves.toBeUndefined();
  });

  it("skips media on service timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({ hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 10 } });

    const pending = events.get("reply_payload_sending")?.({ kind: "final", payload: { text: "y", to: "channel:1" } }, { messageId: "m" });
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toBeUndefined();
  });


  it("does not send pre-reply media or watcher events by default", async () => {
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async () => okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const events = new Map<string, Handler>();
    const api = {
      pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250 } },
      config: { discord: {} },
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendMedia: async (ctx: unknown) => { sent.push(ctx); return { messageId: "sent-media" }; } }) } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
      on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
    };
    plugin.register(api as any);

    await events.get("message_received")?.({ content: "hello", messageId: "u1", to: "channel:123", sessionKey: "s1" }, {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("records inbound messages and evaluates on intake when watcher is enabled", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://hent.test/v1/watcher/record-user") return okJson({ ok: true });
      if (url === "https://hent.test/v1/watcher/evaluate") return okJson({ decision: "no_reply", audit: null });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({ hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250, watcher: true } });

    await events.get("message_received")?.({ content: "hello", messageId: "u1", to: "channel:123", sessionKey: "s1" }, {});

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://hent.test/v1/watcher/record-user",
      "https://hent.test/v1/watcher/evaluate",
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://hent.test/v1/watcher/record-user", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenCalledWith("https://hent.test/v1/watcher/evaluate", expect.objectContaining({ method: "POST" }));
  });

  it("forwards conversation config forwarding options to watcher service requests", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://hent.test/v1/watcher/record-user") return okJson({ ok: true });
      if (url === "https://hent.test/v1/watcher/evaluate") return okJson({ decision: "no_reply", audit: null });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({
      hentAiService: {
        url: "https://hent.test",
        token: "secret",
        timeoutMs: 250,
        conversation: { enabled: true, watcherCompatibility: true },
      },
    });

    await events.get("message_received")?.({ content: "hello", messageId: "u1", to: "channel:123", sessionKey: "s1" }, {});
    await events.get("message_sent")?.({ to: "channel:123", content: "repeat", success: true, messageId: "a1", sessionKey: "s1" }, {});

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://hent.test/v1/watcher/record-user",
      "https://hent.test/v1/watcher/evaluate",  // intake evaluate (on message_received)
      "https://hent.test/v1/watcher/evaluate",  // post-reply evaluate (on message_sent)
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      scopeId: "channel:123:session:s1",
      text: "hello",
      id: "u1",
      channelId: "123",
      conversation: { enabled: true, watcherCompatibility: true },
    });
    // intake evaluate body
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      scopeId: "channel:123:session:s1",
      channelId: "123",
      text: "hello",
      conversation: { enabled: true, watcherCompatibility: true },
    });
    // post-reply evaluate body
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      scopeId: "channel:123:session:s1",
      channelId: "123",
      text: "repeat",
      messageId: "a1",
      sessionId: "s1",
      conversation: { enabled: true, watcherCompatibility: true },
    });
  });

  it("sends no watcher calls when conversation config forwarding is disabled", async () => {
    const fetchMock = vi.fn(async () => okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({
      hentAiService: {
        url: "https://hent.test",
        token: "secret",
        timeoutMs: 250,
        conversation: { enabled: false, watcherCompatibility: true },
      },
    });

    await events.get("message_received")?.({ content: "hello", messageId: "u1", to: "channel:123", sessionKey: "s1" }, {});
    await events.get("message_sent")?.({ to: "channel:123", content: "repeat", success: true, messageId: "a1", sessionKey: "s1" }, {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends pre-reply media only when preReplyMedia is enabled", async () => {
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://hent.test/v1/pre-reply/media") return okJson({ media: { url: "https://cdn.test/focused.png", caption: "" } });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = new Map<string, Handler>();
    const api = {
      pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250, preReplyMedia: { enabled: true } } },
      config: { discord: {} },
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendMedia: async (ctx: unknown) => { sent.push(ctx); return { messageId: "sent-media" }; } }) } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
      on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
    };
    plugin.register(api as any);

    await events.get("message_received")?.({ content: "hello", messageId: "u1", to: "channel:123", sessionKey: "s1" }, {});

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://hent.test/v1/pre-reply/media"]);
    expect(sent).toEqual([expect.objectContaining({ to: "channel:123", mediaUrl: "https://cdn.test/focused.png" })]);
  });

  it("delegates sent-message watcher evaluation, emits service nudge, and commits delivery", async () => {
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://hent.test/v1/watcher/evaluate") return okJson({
        decision: "nudge",
        deliveryPlan: {
          planId: "watcher:delivery-plan:scope-1",
          scopeId: "scope-1",
          channelId: "123",
          chunks: [
            {
              chunkId: "watcher:delivery-plan:scope-1:chunk-1",
              text: "첫 문장",
              delayMs: 10,
              metadata: { hentAiConversationChunk: true, planId: "watcher:delivery-plan:scope-1", chunkIndex: 0, chunkCount: 2 },
            },
            {
              chunkId: "watcher:delivery-plan:scope-1:chunk-2",
              text: "둘째 문장",
              delayMs: 20,
              metadata: { hentAiConversationChunk: true, planId: "watcher:delivery-plan:scope-1", chunkIndex: 1, chunkCount: 2 },
            },
          ],
          commit: {
            planId: "watcher:delivery-plan:scope-1",
            cooldownKey: "scope:stale_expression_repeated",
            signalId: "sig-1",
            requiredChunkIds: ["watcher:delivery-plan:scope-1:chunk-1", "watcher:delivery-plan:scope-1:chunk-2"],
          },
        },
      });
      if (url === "https://hent.test/v1/watcher/commit-delivery") return okJson({ ok: true });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const events = new Map<string, Handler>();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const api = {
      pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250, conversation: { enabled: true } } },
      config: { discord: {} },
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async (ctx: unknown) => {
        sent.push(ctx);
        const index = sent.length;
        return { messageId: `sent-${index}` };
      } }) } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
      on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
    };
    plugin.register(api as any);

    const delivery = events.get("message_sent")?.({ to: "channel:123", content: "repeat repeat", success: true, messageId: "a1", sessionKey: "s1" }, {});

    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual([expect.objectContaining({ to: "channel:123", text: "첫 문장" })]);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10);

    await vi.advanceTimersByTimeAsync(20);
    expect(sent).toEqual([
      expect.objectContaining({ to: "channel:123", text: "첫 문장" }),
      expect.objectContaining({ to: "channel:123", text: "둘째 문장" }),
    ]);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20);

    await vi.runAllTimersAsync();
    await delivery;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://hent.test/v1/watcher/evaluate", "https://hent.test/v1/watcher/commit-delivery"]);
    const commitCall = fetchMock.mock.calls.find(([url]) => url === "https://hent.test/v1/watcher/commit-delivery")?.[1];
    expect(commitCall).toBeDefined();
    expect(JSON.parse(commitCall!.body)).toEqual({
      planId: "watcher:delivery-plan:scope-1",
      cooldownKey: "scope:stale_expression_repeated",
      scopeId: "channel:123:session:s1",
      signalId: "sig-1",
      deliveryMessageIds: {
        "watcher:delivery-plan:scope-1:chunk-1": "sent-1",
        "watcher:delivery-plan:scope-1:chunk-2": "sent-2",
      },
    });
  });

  it("does not commit delivery when any conversation chunk fails to send", async () => {
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://hent.test/v1/watcher/evaluate") return okJson({
        decision: "nudge",
        deliveryPlan: {
          planId: "watcher:delivery-plan:scope-2",
          scopeId: "scope-2",
          channelId: "123",
          chunks: [
            {
              chunkId: "watcher:delivery-plan:scope-2:chunk-1",
              text: "첫 문장",
              delayMs: 0,
              metadata: { hentAiConversationChunk: true, planId: "watcher:delivery-plan:scope-2", chunkIndex: 0, chunkCount: 2 },
            },
            {
              chunkId: "watcher:delivery-plan:scope-2:chunk-2",
              text: "둘째 문장",
              delayMs: 0,
              metadata: { hentAiConversationChunk: true, planId: "watcher:delivery-plan:scope-2", chunkIndex: 1, chunkCount: 2 },
            },
          ],
          commit: {
            planId: "watcher:delivery-plan:scope-2",
            cooldownKey: "scope:stale_expression_repeated",
            signalId: "sig-2",
            requiredChunkIds: ["watcher:delivery-plan:scope-2:chunk-1", "watcher:delivery-plan:scope-2:chunk-2"],
          },
        },
      });
      if (url === "https://hent.test/v1/watcher/commit-delivery") return okJson({ ok: true });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = new Map<string, Handler>();
    const api = {
      pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250, conversation: { enabled: true } } },
      config: { discord: {} },
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async (ctx: unknown) => {
        sent.push(ctx);
        return sent.length === 1 ? { messageId: "chunk-1" } : null;
      } }) } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
      on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
    };
    plugin.register(api as any);

    await events.get("message_sent")?.({ to: "channel:123", content: "repeat repeat", success: true, messageId: "a1", sessionKey: "s1" }, {});

    expect(sent[0]).toEqual({ cfg: { discord: {} }, to: "channel:123", text: "첫 문장" });
    expect(sent[1]).toEqual({ cfg: { discord: {} }, to: "channel:123", text: "둘째 문장" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://hent.test/v1/watcher/evaluate"]);
  });

  it("suppresses self-sent chunk messages with internal loop prevention", async () => {
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://hent.test/v1/watcher/evaluate") return okJson({
        decision: "nudge",
        deliveryPlan: {
          planId: "watcher:delivery-plan:scope-3",
          scopeId: "scope-3",
          channelId: "123",
          chunks: [
            {
              chunkId: "watcher:delivery-plan:scope-3:chunk-1",
              text: "첫 문장",
              delayMs: 0,
              metadata: { hentAiConversationChunk: true, planId: "watcher:delivery-plan:scope-3", chunkIndex: 0, chunkCount: 1 },
            },
          ],
          commit: {
            planId: "watcher:delivery-plan:scope-3",
            cooldownKey: "scope:stale_expression_repeated",
            signalId: "sig-3",
            requiredChunkIds: ["watcher:delivery-plan:scope-3:chunk-1"],
          },
        },
      });
      if (url === "https://hent.test/v1/watcher/commit-delivery") return okJson({ ok: true });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = new Map<string, Handler>();
    const api = {
      pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250, conversation: { enabled: true } } },
      config: { discord: {} },
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async () => ({ messageId: "chunk-msg-1" }) }) } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
      on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
    };
    plugin.register(api as any);

    await events.get("message_sent")?.({ to: "channel:123", content: "repeat repeat", success: true, messageId: "a1", sessionKey: "s1" }, {});
    await events.get("message_sent")?.({
      to: "channel:123",
      content: "첫 문장",
      success: true,
      messageId: "chunk-msg-1",
      sessionKey: "s1",
    }, {});

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://hent.test/v1/watcher/evaluate", "https://hent.test/v1/watcher/commit-delivery"]);
  });

  it("does not evaluate watcher-generated nudges as normal agent turns", async () => {
    const fetchMock = vi.fn(async () => okJson({ decision: "nudge", nudgeText: "fresh angle" }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    await events.get("message_sent")?.({
      to: "channel:123",
      content: "fresh angle",
      success: true,
      messageId: "nudge-1",
      metadata: { hentAiWatcherNudge: true },
    }, {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fail-opens watcher hook service and outbound failures", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://hent.test/v1/watcher/record-user") throw new Error("record down");
      if (url === "https://hent.test/v1/watcher/evaluate") throw new Error("evaluate down");
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = new Map<string, Handler>();
    const api = {
      pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250, watcher: true, preReplyMedia: true } },
      config: { discord: {} },
      runtime: { channel: { outbound: { loadAdapter: async () => ({ sendMedia: async () => { throw new Error("send down"); }, sendText: async () => { throw new Error("send down"); } }) } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
      on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
    };
    plugin.register(api as any);

    await expect(events.get("message_received")?.({ content: "hello", to: "channel:123" }, {})).resolves.toBeUndefined();
    await expect(events.get("message_sent")?.({ to: "channel:123", content: "repeat", success: true, messageId: "a1" }, {})).resolves.toBeUndefined();
  });

  it("contains no forbidden thick-plugin runtime imports or Discord REST paths", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("discord.com");
    expect(source).not.toContain("discordToken");
    expect(source).not.toContain("@hent-ai/generate");
    expect(source).not.toContain("shared/db");
    expect(source).not.toContain("loadManifest");
    expect(source).not.toContain("classifier");
  });

  it("ships only the thin service adapter package surface", () => {
    const metadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(metadata.name).toBe("@hent-ai/openclaw-service-adapter");
    expect(metadata.description).toContain("Thin OpenClaw adapter");
    expect(metadata.files).toEqual(["index.ts", "openclaw.plugin.json", "README.md"]);
    expect(metadata.dependencies).toEqual({});
  });

  it("declares the exact conversation config forwarding schema", () => {
    const metadata = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
    const conversation = metadata.configSchema.properties.hentAiService.properties.conversation;

    expect(conversation).toEqual({
      type: "object",
      description: "Opt-in service-owned group-chat conversation forwarding.",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          description: "Forward group-chat conversation events to the Hent-ai service.",
          default: false,
        },
        watcherCompatibility: {
          type: "boolean",
          description: "Also enable legacy watcher-compatible record/evaluate forwarding while the service owns policy.",
          default: true,
        },
      },
    });
  });
});
