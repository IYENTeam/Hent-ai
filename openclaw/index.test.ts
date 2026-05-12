import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
   detectEmotion,
   MEDIA_LINE_RE,
   editMessageWithImage,
   buildEmotionRules,
   detectEmotionWithLLM,
   detectApiType,
   extractEmotion,
   assertPathInside,
   expandEnvPlaceholder,
 } from "./index.js";

describe("detectEmotion", () => {
  it("returns 'happy' when text contains completion keywords", () => {
    expect(detectEmotion("Task completed successfully")).toBe("happy");
  });

  it("returns 'sorry' when text contains apology keywords", () => {
    expect(detectEmotion("Sorry, I made a mistake.")).toBe("sorry");
  });

  it("returns 'confused' for question-like text", () => {
    expect(detectEmotion("How should we proceed? I have a question.")).toBe("confused");
  });

  it("returns 'focused' for investigation keywords", () => {
    expect(detectEmotion("Currently debugging the code. Testing in progress")).toBe("focused");
  });

  it("returns 'loyalty' for greeting keywords", () => {
    expect(detectEmotion("Got it, understood")).toBe("loyalty");
  });

  it("returns 'neutral' when no keywords match (default fallback)", () => {
    expect(detectEmotion("The weather is nice today")).toBe("neutral");
  });

  it("returns custom fallback when passed", () => {
    expect(detectEmotion("nothing special here", undefined, "happy")).toBe("happy");
  });

  it("respects custom rules passed as second argument", () => {
    const customRules = [{ emotion: "sleepy", patterns: [/drowsy|sleepy/i] }];
    expect(detectEmotion("feeling so drowsy", customRules)).toBe("sleepy");
  });

  it("matches case-insensitively", () => {
    expect(detectEmotion("DONE SUCCEED")).toBe("happy");
  });

  it("prefers first matching emotion when multiple rules match", () => {
    expect(detectEmotion("Sorry, still analyzing")).toBe("sorry");
  });
});

describe("MEDIA_LINE_RE", () => {
  it("strips MEDIA: lines with absolute paths", () => {
    const input = "Here are the results.\nMEDIA:/Users/test/project/assets/happy.png";
    expect(input.replace(MEDIA_LINE_RE, "").trimEnd()).toBe("Here are the results.");
  });

  it("strips MEDIA: lines with relative paths", () => {
    const input = "Analysis done.\nMEDIA:./assets/happy.png";
    expect(input.replace(MEDIA_LINE_RE, "").trimEnd()).toBe("Analysis done.");
  });

  it("preserves content when no MEDIA line exists", () => {
    const input = "Just a normal message.";
    expect(input.replace(MEDIA_LINE_RE, "").trimEnd()).toBe("Just a normal message.");
  });

  it("strips multiple MEDIA: lines", () => {
    const input = "Results\nMEDIA:/path/a.png\nMore info\nMEDIA:/path/b.png";
    expect(input.replace(MEDIA_LINE_RE, "").trimEnd()).toBe("Results\nMore info");
  });

  it("does not strip MEDIA: at start of string (no leading newline)", () => {
    const input = "MEDIA:/path/file.png\ncontent";
    expect(input.replace(MEDIA_LINE_RE, "").trimEnd()).toBe("MEDIA:/path/file.png\ncontent");
  });
});

describe("channel: prefix strip", () => {
  it("strips channel: prefix from channel ID", () => {
    const to = "channel:123456789";
    expect(to.startsWith("channel:") ? to.slice(8) : to).toBe("123456789");
  });

  it("passes through plain channel ID", () => {
    const to = "123456789";
    expect(to.startsWith("channel:") ? to.slice(8) : to).toBe("123456789");
  });
});

describe("buildEmotionRules", () => {
  it("returns default rules when no custom rules provided", () => {
    const rules = buildEmotionRules();
    expect(rules.length).toBeGreaterThan(0);
    const emotions = rules.map((r) => r.emotion);
    expect(emotions).toContain("happy");
    expect(emotions).toContain("sorry");
    expect(emotions).toContain("focused");
  });

  it("merges custom keywords into existing emotion", () => {
    const custom = { happy: ["\\b(perfect|excellent)\\b"] };
    const rules = buildEmotionRules(custom);
    const happyRule = rules.find((r) => r.emotion === "happy")!;
    expect(happyRule.patterns.length).toBeGreaterThanOrEqual(3);
  });

  it("creates new emotion from custom rules", () => {
    const custom = { sleepy: ["\\b(drowsy|sleepy)\\b"] };
    const rules = buildEmotionRules(custom);
    expect(rules.find((r) => r.emotion === "sleepy")).toBeDefined();
  });

  it("preserves all default emotions when adding custom rules", () => {
    const custom = { happy: ["custom_pattern"] };
    const rules = buildEmotionRules(custom);
    expect(rules.find((r) => r.emotion === "sorry")).toBeDefined();
    expect(rules.find((r) => r.emotion === "happy")).toBeDefined();
  });
});

describe("editMessageWithImage", () => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends PATCH request to Discord API with multipart form-data", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(""),
    } as unknown as Response);

    const imagePath = new URL("../assets/neutral.png", import.meta.url).pathname;

    await editMessageWithImage(
      "bot-token-123",
      "channel-456",
      "msg-789",
      "Hello!",
      imagePath,
      mockLogger,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/channel-456/messages/msg-789");
    expect(options.method).toBe("PATCH");
    expect(options.headers).toMatchObject({
      Authorization: "Bot bot-token-123",
    });
    expect((options.headers as Record<string, string>)["Content-Type"]).toContain(
      "multipart/form-data",
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("attached neutral.png to message msg-789"),
    );
  });

  it("logs warning on Discord API error", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('{"message": "Invalid Form Body"}'),
    } as unknown as Response);

    const imagePath = new URL("../assets/neutral.png", import.meta.url).pathname;

    await editMessageWithImage(
      "bot-token-123",
      "channel-456",
      "msg-789",
      "Hello!",
      imagePath,
      mockLogger,
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Discord edit failed 400"),
    );
  });

  it("logs error on exception", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const imagePath = new URL("../assets/neutral.png", import.meta.url).pathname;

    await editMessageWithImage(
      "bot-token-123",
      "channel-456",
      "msg-789",
      "Hello!",
      imagePath,
      mockLogger,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("edit error"),
    );
  });

  it("logs error when image file does not exist", async () => {
    await editMessageWithImage(
      "bot-token-123",
      "channel-456",
      "msg-789",
      "Hello!",
      "/nonexistent/path/image.png",
      mockLogger,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("edit error"),
    );
  });

  it("includes cleaned content and attachment metadata in PATCH body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(""),
    } as unknown as Response);

    const imagePath = new URL("../assets/neutral.png", import.meta.url).pathname;

    await editMessageWithImage(
      "bot-token",
      "ch",
      "msg",
      "Hello world",
      imagePath,
      mockLogger,
    );

    const [, options] = mockFetch.mock.calls[0];
    const bodyStr = (options.body as Buffer).toString();
    expect(bodyStr).toContain("Hello world");
    expect(bodyStr).toContain("neutral.png");
    expect(bodyStr).toContain("files[0]");
  });
});

describe("detectApiType", () => {
  it('returns "openai-completions" for undefined', () => {
    expect(detectApiType(undefined)).toBe("openai-completions");
  });

  it('returns "openai-completions" for "openai-completions"', () => {
    expect(detectApiType("openai-completions")).toBe("openai-completions");
  });

  it('returns "openai-completions" for unknown api value', () => {
    expect(detectApiType("some-unknown-api")).toBe("openai-completions");
  });

  it('returns "anthropic-messages" for "anthropic-messages"', () => {
    expect(detectApiType("anthropic-messages")).toBe("anthropic-messages");
  });
});

describe("extractEmotion", () => {
  const emotions = ["happy", "neutral", "sorry", "confused", "focused", "loyalty"];

  it("returns null for null content", () => {
    expect(extractEmotion(null, emotions)).toBeNull();
  });

  it("returns null for undefined content", () => {
    expect(extractEmotion(undefined, emotions)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractEmotion("", emotions)).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(extractEmotion("   ", emotions)).toBeNull();
  });

  it("returns exact match", () => {
    expect(extractEmotion("happy", emotions)).toBe("happy");
  });

  it("handles case insensitivity", () => {
    expect(extractEmotion("HAPPY", emotions)).toBe("happy");
  });

  it("trims surrounding whitespace", () => {
    expect(extractEmotion("  happy  ", emotions)).toBe("happy");
  });

  it("strips surrounding double quotes", () => {
    expect(extractEmotion('"happy"', emotions)).toBe("happy");
  });

  it("strips surrounding single quotes", () => {
    expect(extractEmotion("'happy'", emotions)).toBe("happy");
  });

  it("strips surrounding curly/smart quotes", () => {
    expect(extractEmotion("\u201Chappy\u201D", emotions)).toBe("happy");
    expect(extractEmotion("\u2018happy\u2019", emotions)).toBe("happy");
  });

  it("handles multi-line response with exact match on one line", () => {
    expect(extractEmotion("hello\nsorry\nworld", emotions)).toBe("sorry");
  });

  it("returns null when emotion not in valid list", () => {
    expect(extractEmotion("angry", emotions)).toBeNull();
  });

  it("finds emotion via word-boundary in extra text", () => {
    expect(extractEmotion("The emotion is: happy", emotions)).toBe("happy");
    expect(extractEmotion("I would classify this as focused", emotions)).toBe("focused");
  });

  it("finds emotion when response has trailing punctuation", () => {
    expect(extractEmotion("happy!", emotions)).toBe("happy");
    expect(extractEmotion("neutral.", emotions)).toBe("neutral");
    expect(extractEmotion("sorry?", emotions)).toBe("sorry");
  });

  it("prefers first matching emotion in text", () => {
    expect(extractEmotion("loyalty happy focused", emotions)).toBe("loyalty");
  });
});

describe("detectEmotionWithLLM", () => {
  const mockLogger = { warn: vi.fn() };
  const validEmotions = ["happy", "neutral", "sorry"];

  function mockRuntime(overrides?: {
    baseUrl?: string;
    api?: string;
    resolveApiKeyError?: boolean;
    noApiKey?: boolean;
  }) {
    const baseUrl = overrides?.baseUrl ?? "https://api.openai.com/v1";
    const api = overrides?.api ?? "openai-completions";

    let resolveApiKeyFn: ReturnType<typeof vi.fn>;
    if (overrides?.resolveApiKeyError) {
      resolveApiKeyFn = vi.fn().mockRejectedValue(new Error("auth error"));
    } else if (overrides?.noApiKey) {
      resolveApiKeyFn = vi.fn().mockResolvedValue({ apiKey: undefined });
    } else {
      resolveApiKeyFn = vi.fn().mockResolvedValue({ apiKey: "sk-test-key" });
    }

    return {
      config: {
        current: () => ({
          models: {
            providers: {
              "openai": { baseUrl, api },
            },
          },
        }),
      },
      modelAuth: {
        resolveApiKeyForProvider: resolveApiKeyFn,
      },
    };
  }

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns emotion when OpenAI classification succeeds", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "happy" } }],
      }),
    } as unknown as Response);

    const runtime = mockRuntime();
    const result = await detectEmotionWithLLM(
      "openai/gpt-4o-mini",
      "This is great!",
      validEmotions,
      runtime as never,
      mockLogger,
    );

    expect(result).toBe("happy");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect((opts as Record<string, unknown>).headers).toMatchObject({
      Authorization: "Bearer sk-test-key",
    });
  });

  it("returns null when classifierModel has no '/' separator", async () => {
    const runtime = mockRuntime();
    const result = await detectEmotionWithLLM(
      "openai",
      "test",
      validEmotions,
      runtime as never,
      mockLogger,
    );

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing \"/\" separator"),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when provider config is not found", async () => {
    const runtime = {
      config: {
        current: () => ({ models: { providers: {} } }),
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn(),
      },
    };

    const result = await detectEmotionWithLLM(
      "unknown-provider/model",
      "test",
      validEmotions,
      runtime as never,
      mockLogger,
    );

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('provider "unknown-provider" not found'),
    );
  });

  it("returns null when no apiKey resolved", async () => {
    const runtime = {
      config: {
        current: () => ({
          models: {
            providers: {
              "openai": { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
            },
          },
        }),
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn().mockResolvedValue({ apiKey: undefined }),
      },
    };

    const result = await detectEmotionWithLLM(
      "openai/gpt-4o-mini",
      "test",
      validEmotions,
      runtime as never,
      mockLogger,
    );

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no apiKey resolved"),
    );
  });

  it("returns null when auth throws", async () => {
    const runtime = mockRuntime({ resolveApiKeyError: true });
    const result = await detectEmotionWithLLM(
      "openai/gpt-4o-mini",
      "test",
      validEmotions,
      runtime as never,
      mockLogger,
    );

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to resolve apiKey"),
    );
  });

  it("returns null when LLM returns emotion not in validEmotions", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "angry" } }],
      }),
    } as unknown as Response);

    const runtime = mockRuntime();
    const result = await detectEmotionWithLLM(
      "openai/gpt-4o-mini",
      "test",
      validEmotions,
      runtime as never,
      mockLogger,
    );

    expect(result).toBeNull();
  });

  it("returns null when LLM call fails (network error)", async () => {
    mockFetch.mockRejectedValue(new Error("Network failure"));

    const runtime = mockRuntime();
    const result = await detectEmotionWithLLM(
      "openai/gpt-4o-mini",
      "test",
      validEmotions,
      runtime as never,
      mockLogger,
    );

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("LLM call error"),
    );
  });

  it("returns null when LLM response is not ok (non-200 status)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue("rate limited"),
    } as unknown as Response);

    const runtime = mockRuntime();
    const result = await detectEmotionWithLLM(
      "openai/gpt-4o-mini",
      "test",
      validEmotions,
      runtime as never,
      mockLogger,
    );

     expect(result).toBeNull();
   });
 });

describe("assertPathInside", () => {
   it("returns normalized path when candidate is inside root", () => {
     const root = "/home/user/assets";
     const candidate = "happy.png";
     const result = assertPathInside(root, candidate);
     expect(result).toBe("/home/user/assets/happy.png");
   });

   it("returns null when candidate escapes root via parent traversal", () => {
     const root = "/home/user/assets";
     const candidate = "../../etc/passwd";
     const result = assertPathInside(root, candidate);
     expect(result).toBeNull();
   });

   it("returns null when candidate is absolute and outside root", () => {
     const root = "/home/user/assets";
     const candidate = "/etc/passwd";
     const result = assertPathInside(root, candidate);
     expect(result).toBeNull();
   });

   it("returns path when candidate equals root", () => {
     const root = "/home/user/assets";
     const candidate = ".";
     const result = assertPathInside(root, candidate);
     expect(result).toBe("/home/user/assets");
   });

   it("returns null when candidate prefix overlaps but escapes", () => {
     const root = "/home/user/assets";
     const candidate = "../assets-evil/file.png";
     const result = assertPathInside(root, candidate);
     expect(result).toBeNull();
   });

   it("handles relative root paths", () => {
     const root = "./assets";
     const candidate = "happy.png";
     const result = assertPathInside(root, candidate);
     expect(result).toBeTruthy();
     expect(result).toContain("assets/happy.png");
   });

   it("returns null for deeply nested parent traversal", () => {
     const root = "/home/user/assets";
     const candidate = "../../../../../../../../etc/passwd";
     const result = assertPathInside(root, candidate);
     expect(result).toBeNull();
   });

   it("returns path for nested subdirectories inside root", () => {
     const root = "/home/user/assets";
     const candidate = "emotions/happy.png";
     const result = assertPathInside(root, candidate);
     expect(result).toBe("/home/user/assets/emotions/happy.png");
   });
 });

describe("expandEnvPlaceholder", () => {
   beforeEach(() => {
     process.env.TEST_VAR = "test_value";
     process.env.EMOTION_IMAGE_DISCORD_TOKEN = "bot_token_123";
   });

   afterEach(() => {
     delete process.env.TEST_VAR;
     delete process.env.EMOTION_IMAGE_DISCORD_TOKEN;
   });

   it("returns original string when no placeholder", () => {
     const result = expandEnvPlaceholder("literal_token");
     expect(result).toBe("literal_token");
   });

   it("expands ${ENV_VAR} placeholder to env value", () => {
     const result = expandEnvPlaceholder("${TEST_VAR}");
     expect(result).toBe("test_value");
   });

   it("expands ${EMOTION_IMAGE_DISCORD_TOKEN} placeholder", () => {
     const result = expandEnvPlaceholder("${EMOTION_IMAGE_DISCORD_TOKEN}");
     expect(result).toBe("bot_token_123");
   });

   it("returns undefined when env var is missing", () => {
     const result = expandEnvPlaceholder("${NONEXISTENT_VAR}");
     expect(result).toBeUndefined();
   });

   it("returns undefined when input is undefined", () => {
     const result = expandEnvPlaceholder(undefined);
     expect(result).toBeUndefined();
   });

   it("returns undefined when input is empty string", () => {
     const result = expandEnvPlaceholder("");
     expect(result).toBeUndefined();
   });

   it("does not expand placeholder in middle of string", () => {
     const result = expandEnvPlaceholder("prefix_${TEST_VAR}_suffix");
     expect(result).toBe("prefix_${TEST_VAR}_suffix");
   });

   it("is case-insensitive for env var names", () => {
     process.env.lowercase_var = "value";
     const result = expandEnvPlaceholder("${LOWERCASE_VAR}");
     expect(result).toBe("value");
     delete process.env.lowercase_var;
   });
 });
