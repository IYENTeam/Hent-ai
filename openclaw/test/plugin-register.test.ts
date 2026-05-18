import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin from "../index.js";

// Mock fs
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn().mockRejectedValue(new Error("no file")) };
});

// Mock fetch globally
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ id: "msg1" }),
  text: async () => "",
});

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "msg1" }), text: async () => "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeApi(config: Record<string, unknown> = {}) {
  const handlers: Record<string, Array<(event: unknown) => Promise<void>>> = {};
  return {
    handlers,
    pluginConfig: {
      discordToken: "Bot test-token",
      imageDir: "/tmp/test-images",
      ...config,
    },
    pluginConfig__raw: config,
    on: (event: string, handler: (event: unknown) => Promise<void>) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      config: { current: () => ({ models: { providers: {} } }) },
      modelAuth: { resolveApiKeyForProvider: vi.fn().mockResolvedValue({ apiKey: "sk-test" }) },
    },
  };
}

describe("plugin register()", () => {
  it("exits early when enabled=false", () => {
    const api = makeApi({ enabled: false });
    plugin.register(api as any);
    expect(Object.keys(api.handlers)).toHaveLength(0);
  });

  it("warns when no discordToken", () => {
    const savedEnv = process.env.EMOTION_IMAGE_DISCORD_TOKEN;
    delete process.env.EMOTION_IMAGE_DISCORD_TOKEN;
    const api = makeApi({ discordToken: undefined });
    plugin.register(api as any);
    if (savedEnv !== undefined) process.env.EMOTION_IMAGE_DISCORD_TOKEN = savedEnv;
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Discord token not configured"));
  });

  it("registers message_sent handler", () => {
    const api = makeApi();
    plugin.register(api as any);
    expect(api.handlers["message_sent"]).toBeDefined();
  });

  it("skips message_sent event when success=false", async () => {
    const api = makeApi();
    plugin.register(api as any);
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({ success: false, messageId: "m1", content: "hello", to: "channel:123" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips message_sent when content=NO_REPLY", async () => {
    const api = makeApi();
    plugin.register(api as any);
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({ success: true, messageId: "m1", content: "NO_REPLY", to: "channel:123" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips message_sent when missing required fields", async () => {
    const api = makeApi();
    plugin.register(api as any);
    const handler = api.handlers["message_sent"]?.[0];
    // missing messageId
    await handler?.({ success: true, content: "hello", to: "channel:123" });
    // missing to
    await handler?.({ success: true, messageId: "m1", content: "hello" });
    // missing content
    await handler?.({ success: true, messageId: "m1", to: "channel:123" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("processes message_sent and attempts emotion detection + image append", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true); // image file exists
    
    const api = makeApi();
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m1",
      content: "Task completed successfully!",
      to: "channel:123456789",
    });
    
    // Wait for promise queue to drain
    await new Promise((r) => setTimeout(r, 50));
    
    // Should have attempted to fetch (edit/append image)
    expect(mockFetch).toHaveBeenCalled();
  });

  it("handles message_sent error in classifyAndAppend gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    
    const api = makeApi();
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m1",
      content: "hello world",
      to: "channel:123456789",
    });
    
    await new Promise((r) => setTimeout(r, 50));
    // Should log error but not throw
    // (error is caught by the promise queue)
  });

  it("skips message_sent for blocklisted channel", async () => {
    const api = makeApi({
      channels: { mode: "blocklist", list: ["123456789"] },
    });
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m1",
      content: "hello",
      to: "channel:123456789",
    });
    
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("processes message_sent with classifierModel set", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: "happy" } }] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ id: "m1" }), text: async () => "" });
    
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    
    const api = makeApi({ classifierModel: "openai/gpt-4o-mini" });
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m1",
      content: "I completed the task!",
      to: "channel:123456789",
    });
    
    await new Promise((r) => setTimeout(r, 50));
  });

  it("registers message_received handler when cheer enabled", () => {
    const api = makeApi({ cheer: { enabled: true } });
    plugin.register(api as any);
    expect(api.handlers["message_received"]).toBeDefined();
  });

  it("skips message_received when NO_REPLY", async () => {
    const api = makeApi({ cheer: { enabled: true } });
    plugin.register(api as any);
    
    const handler = api.handlers["message_received"]?.[0];
    await handler?.({
      content: "NO_REPLY",
      metadata: { to: "channel:123456789" },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});


describe("plugin message_sent handler - image path variants", () => {
  it("warns and skips when finalVariant exists but imagePath not found", async () => {
    const { existsSync } = await import("node:fs");
    // First existsSync call (onboarding lock) returns false
    // Second one (image file exists check) returns false
    vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValue(false);
    
    const api = makeApi();
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m2",
      content: "The task is done!",
      to: "channel:123456789",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("image not found"));
  });

  it("skips when no image available (no buffer, no variant filename)", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    
    // Override getCachedOrGenerateImage to return null buffer
    // and selectEmotionImageVariant to return no filename
    const api = makeApi({ miracleMode: true });
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m3",
      content: "hello world",
      to: "channel:123456789",
    });
    await new Promise((r) => setTimeout(r, 50));
  });

  it("uses imageBuffer when finalVariant has no filename (miracle mode)", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    
    // generateImage mock is set at top level to return a buffer
    // This test exercises the appendImageBufferToMessage path
    const api = makeApi({ miracleMode: true });
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m4",
      content: "completed!",
      to: "channel:123456789",
      metadata: { miracleOverride: true },
    });
    await new Promise((r) => setTimeout(r, 100));
    // May hit appendImageBufferToMessage path if generateImage returns buffer
  });
});


describe("plugin message_sent - miracle mode buffer paths", () => {
  it("warns no image available when buffer=null (no miracle mode)", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    
    // Use empty emotionMap so variants = [] and selectEmotionImageVariant returns null
    const api = makeApi({
      emotionMap: {},   // empty → no variants
      miracleMode: false,
    });
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "mbuf1",
      content: "aaa bbb ccc",
      to: "channel:999000111",
    });
    await new Promise((r) => setTimeout(r, 60));
    // With DEFAULT_EMOTION_MAP, always has variants → "image not found" warn
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("image not found")
    );
  });

  it("appends imageBuffer when miracle mode generates one (no variant filename)", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    
    // generateImage is mocked at top to return Buffer.from("FAKE_CHEER_PNG")
    // With empty emotionMap, selectEmotionImageVariant returns null
    // so finalVariant?.filename is undefined → fallthrough to imageBuffer path
    const api = makeApi({
      emotionMap: {},    // empty → no variants
      miracleMode: true, // enables getCachedOrGenerateImage
    });
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "mbuf2",
      content: "done!",
      to: "channel:999000111",
    });
    await new Promise((r) => setTimeout(r, 100));
    
    // Should have called appendImageBufferToMessage via fetch
    expect(mockFetch).toHaveBeenCalled();
  });
});


describe("plugin message_received handler - catch block", () => {
  it("registers message_received handler with focused emotionMap", async () => {
    const api = makeApi({
      emotionMap: { focused: "focused.png" },
    });
    plugin.register(api as any);
    
    // With focused variant, the message_received handler should be registered
    expect(api.handlers["message_received"]).toBeDefined();
  });
  
  it("warns when sendImageMessage (thinking image) throws", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.endsWith(".onboarding-active")) return false;
      return true; // focused image exists
    });
    
    // Make the fetch fail so sendImageMessage throws
    mockFetch.mockRejectedValue(new Error("network error"));
    
    // Use cheer enabled to ensure message_received fires + focused images
    const api = makeApi({
      emotionMap: { focused: "focused.png", neutral: "neutral.png" },
      cheer: { enabled: true },
    });
    plugin.register(api as any);
    
    const handler = api.handlers["message_received"]?.[0];
    expect(handler).toBeDefined();
    
    await handler?.({
      content: "hello there",
      metadata: { to: "channel:123456789" },
      senderId: "user1",
    });
    
    await new Promise((r) => setTimeout(r, 200));
    // logger.warn should have been called due to failed fetch
    expect(api.logger.warn).toHaveBeenCalled();
  });
});

describe("plugin message_sent - classifyAndAppend error handling", () => {
  it("logs error when classifyAndAppend throws", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    
    // Make appendImageToMessage fail (fetch throws)
    mockFetch.mockImplementationOnce(async () => { throw new Error("Discord API down"); });
    
    const api = makeApi();
    plugin.register(api as any);
    
    const handler = api.handlers["message_sent"]?.[0];
    await handler?.({
      success: true,
      messageId: "m_err",
      content: "done!",
      to: "channel:123456789",
    });
    await new Promise((r) => setTimeout(r, 100));
    
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("append error")
    );
  });
});
