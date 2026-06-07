import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  expandEnvPlaceholder,
  normalizeServiceMedia,
  resolveServiceConfig,
  validateServiceConfig,
} from "./index.js";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

function setup(config: unknown = { hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 250 } }) {
  const events = new Map<string, Handler>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = {
    pluginConfig: config,
    logger,
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

  it("registers only the current OpenClaw reply payload media hook", () => {
    const { api, events } = setup();
    expect([...events.keys()]).toEqual(["reply_payload_sending"]);
    expect(api.on).toHaveBeenCalledWith("reply_payload_sending", expect.any(Function), { name: "hent-ai-reply-payload-media" });
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

  it("calls pre-reply service for block payloads with bearer auth and attaches media", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hent.test/v1/pre-reply/media");
    expect(options.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(options.body).context).toMatchObject({ channelId: "123", userMessage: "hello", preReplyText: "thinking" });
    expect(result).toEqual({
      payload: { text: "thinking", channelData: { channelPolicy: "service-owned" }, mediaUrl: "https://cdn.test/pre.png" },
    });
  });
  it("uses hook context when OpenClaw event omits a direct channel id", async () => {
    const fetchMock = vi.fn(async () => okJson({ media: { url: "https://cdn.test/pre.png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup({ hentAiService: { url: "https://hent.test", token: "secret", timeoutMs: 2500 } });

    await events.get("reply_payload_sending")?.(
      { kind: "block", payload: { text: "draft", to: "channel:from-to" }, sessionKey: "s", runId: "r" },
      { conversationId: "channel:from-context", sessionKey: "s", runId: "r", replyToBody: "inbound" },
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context).toMatchObject({
      to: "channel:from-to",
      channelId: "from-context",
      userMessage: "inbound",
      preReplyText: "draft",
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
    ["malformed", { media: { caption: "missing url" } }],
  ])("skips pre-reply media on %s service response", async (_name, payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson(payload)));
    const { events, logger } = setup();
    const result = await events.get("reply_payload_sending")?.({ kind: "block", payload: { text: "y" } }, { channelId: "1", replyToBody: "x" });
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

    const pending = events.get("reply_payload_sending")?.({ kind: "block", payload: { text: "y" } }, { channelId: "1", replyToBody: "x" });
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toBeUndefined();
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
});
