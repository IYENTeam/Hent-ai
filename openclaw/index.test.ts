import { generateImage } from "@hent-ai/generate";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPathInside,
  buildCheerPrompt,
  buildEmotionRules,
  detectCheerIntentWithLLM,
  detectApiType,
  detectEmotion,
  detectEmotionWithLLM,
  editMessageWithImage,
  expandEnvPlaceholder,
  extractBooleanIntent,
  extractEmotion,
  getCachedOrGenerateImage,
  handleCheerRequest,
  imageLabelMatchesContext,
  inferAutomaticImageLabel,
  isOnboardingActive,
  MEDIA_LINE_RE,
  normalizeEmotionImageConfig,
  resolveImageDir,
  resolveProfileWorkspaceDir,
  selectEmotionImageVariant,
} from "./index.js";

vi.mock("@hent-ai/generate", () => ({
  generateImage: vi.fn(async () => Buffer.from("FAKE_CHEER_PNG")),
}));

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
            openai: { baseUrl, api },
          },
        },
      }),
    },
    modelAuth: {
      resolveApiKeyForProvider: resolveApiKeyFn,
    },
  };
}

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

  it("returns 'neutral' for greeting keywords (loyalty removed)", () => {
    expect(detectEmotion("Got it, understood")).toBe("neutral");
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

describe("cheer request helpers", () => {
  it("parses positive binary intent responses", () => {
    expect(extractBooleanIntent("yes")).toBe(true);
    expect(extractBooleanIntent("TRUE")).toBe(true);
    expect(extractBooleanIntent('"yes"')).toBe(true);
    expect(extractBooleanIntent("Intent: yes")).toBe(true);
  });

  it("parses negative and invalid binary intent responses conservatively", () => {
    expect(extractBooleanIntent("no")).toBe(false);
    expect(extractBooleanIntent("FALSE")).toBe(false);
    expect(extractBooleanIntent("maybe")).toBeNull();
  });

  it("builds a safe non-explicit cheer image prompt", () => {
    const prompt = buildCheerPrompt("orange cat idol");
    expect(prompt).toContain("orange cat idol");
    expect(prompt).toContain("화이팅");
    expect(prompt).toContain("more visible skin");
    expect(prompt).toContain("adult character");
    expect(prompt).toContain("no nudity");
    expect(prompt).toContain("no nipples");
  });

  it("generates and sends a cheer image through the Discord surface", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "msg-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await handleCheerRequest({
      token: "token",
      channelId: "123456789",
      imageDir: "/tmp/no-base-image",
      config: { character: "orange cat idol", size: "512x512" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(generateImage).toHaveBeenCalledWith({
      prompt: buildCheerPrompt("orange cat idol"),
      model: undefined,
      size: "512x512",
      referenceImages: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toContain("응원 이미지를 만들고 있어요");
    expect(Buffer.isBuffer(fetchMock.mock.calls[1][1].body)).toBe(true);
    expect(fetchMock.mock.calls[1][1].body.toString()).toContain("cheer.png");
    expect(fetchMock.mock.calls[1][1].body.toString()).toContain("화이팅! 오늘도 충분히 잘하고 있어요.");
  });

  it("detects indirect Korean cheer intent with the configured LLM", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "yes" } }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await detectCheerIntentWithLLM(
      "openai/gpt-5.4-mini",
      "오늘 너무 지쳤는데 기운 좀 줄 수 있어?",
      mockRuntime() as never,
      { warn: vi.fn() },
    );

    expect(result).toBe(true);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.messages[0].content).toContain("encourage, cheer up, comfort, support, motivate");
    expect(body.messages[0].content).toContain("오늘 너무 지쳤는데 기운 좀 줄 수 있어?");
  });

  it("does not detect non-cheer intent when the configured LLM says no", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "no" } }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await detectCheerIntentWithLLM(
      "openai/gpt-5.4-mini",
      "응원 고마워, 그런데 설정 방법 알려줘",
      mockRuntime() as never,
      { warn: vi.fn() },
    );

    expect(result).toBe(false);
  });
});

describe("emotion image variants", () => {
  it("normalizes legacy single filename config", () => {
    expect(normalizeEmotionImageConfig("happy.png")).toEqual([
      { filename: "happy.png", weight: 1 },
    ]);
  });

  it("normalizes labeled image pools", () => {
    expect(normalizeEmotionImageConfig([
      "happy.png",
      { file: "happy-stage.png", label: "stage", weight: 3 },
      { filename: "happy-soft.png", label: "soft" },
    ])).toEqual([
      { filename: "happy.png", weight: 1 },
      { filename: "happy-stage.png", label: "stage", weight: 3 },
      { filename: "happy-soft.png", label: "soft", weight: 1 },
    ]);
  });

  it("infers labels from custom image filenames", () => {
    expect(inferAutomaticImageLabel("happy-stage-light.png")).toBe("stage light");
    expect(inferAutomaticImageLabel("neutral.png")).toBeUndefined();
    expect(normalizeEmotionImageConfig({ file: "happy-date-night.png" })).toEqual([
      { filename: "happy-date-night.png", label: "date night", weight: 1 },
    ]);
  });

  it("matches labels against response context", () => {
    expect(imageLabelMatchesContext("stage light", "The stage is ready now.")).toBe(true);
    expect(imageLabelMatchesContext("date night", "오늘 데이트 준비 끝")).toBe(false);
    expect(imageLabelMatchesContext(undefined, "stage")).toBe(false);
  });

  it("selects a weighted random variant", () => {
    const variants = normalizeEmotionImageConfig([
      { file: "first.png", weight: 1 },
      { file: "second.png", weight: 3 },
    ]);

    expect(selectEmotionImageVariant(variants, () => 0.1)?.filename).toBe("first.png");
    expect(selectEmotionImageVariant(variants, () => 0.9)?.filename).toBe("second.png");
  });

  it("prefers label-matching variants before weighted fallback", () => {
    const variants = normalizeEmotionImageConfig([
      { file: "happy-generic.png", weight: 100 },
      { file: "happy-stage.png", label: "stage", weight: 1 },
    ]);

    expect(selectEmotionImageVariant(variants, () => 0, "Stage deployment complete")?.filename).toBe("happy-stage.png");
    expect(selectEmotionImageVariant(variants, () => 0, "General update")?.filename).toBe("happy-generic.png");
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

describe("isOnboardingActive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `hent-onboarding-lock-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects the root image directory onboarding lock", () => {
    writeFileSync(join(tmpDir, ".onboarding-active"), "");

    expect(isOnboardingActive(tmpDir)).toBe(true);
  });

  it("detects a profile/private image directory onboarding lock", () => {
    const privateDir = join(tmpDir, "profiles", "private");
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(privateDir, ".onboarding-active"), "");

    expect(isOnboardingActive(tmpDir, privateDir)).toBe(true);
  });

  it("returns false when neither root nor active profile has a lock", () => {
    const privateDir = join(tmpDir, "profiles", "private");
    mkdirSync(privateDir, { recursive: true });

    expect(isOnboardingActive(tmpDir, privateDir)).toBe(false);
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
    const happyRule = rules.find((r) => r.emotion === "happy");
    expect(happyRule?.patterns.length).toBeGreaterThanOrEqual(3);
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
  const emotions = ["happy", "neutral", "sorry", "confused", "focused"];

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
    expect(extractEmotion("happy focused neutral", emotions)).toBe("happy");
  });
});

describe("detectEmotionWithLLM", () => {
  const mockLogger = { warn: vi.fn() };
  const validEmotions = ["happy", "neutral", "sorry"];

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
      "openai/gpt-5.4-mini",
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
      "openai/gpt-5.4-mini",
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
      "openai/gpt-5.4-mini",
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
      "openai/gpt-5.4-mini",
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
      "openai/gpt-5.4-mini",
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
      "openai/gpt-5.4-mini",
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

describe("resolveProfileWorkspaceDir", () => {
  it("reads workspace from common OpenClaw profile config shapes", () => {
    expect(resolveProfileWorkspaceDir({ workspace: "/profiles/alpha" })).toBe("/profiles/alpha");
    expect(resolveProfileWorkspaceDir({ agent: { workspaceDir: "/profiles/beta" } })).toBe("/profiles/beta");
    expect(resolveProfileWorkspaceDir({ profile: { agentDir: "/profiles/gamma" } })).toBe("/profiles/gamma");
  });

  it("returns undefined when no workspace field exists", () => {
    expect(resolveProfileWorkspaceDir({ models: { providers: {} } })).toBeUndefined();
  });
});

describe("resolveImageDir", () => {
  it("uses explicit imageDir before profile workspace", () => {
    const dir = resolveImageDir("/custom/assets", "/extension/dist", {
      config: { current: () => ({ workspace: "/profiles/alpha" }) },
    });

    expect(dir).toBe("/custom/assets");
  });

  it("isolates default assets under the active profile workspace", () => {
    const dir = resolveImageDir(undefined, "/extension/dist", {
      config: { current: () => ({ workspace: "/profiles/alpha" }) },
    });

    expect(dir).toBe("/profiles/alpha/.hent-ai/emotion-image-assets");
  });

  it("uses event metadata workspace id when no workspace directory is available", () => {
    const dir = resolveImageDir(undefined, "/extension/dist", {
      config: { current: () => ({ models: { providers: {} } }) },
    }, {
      metadata: { workspaceId: "team/alpha" },
    });

    expect(dir).toBe("/extension/assets/profiles/team_alpha");
  });

  it("uses sessionKey workspace prefix when metadata is absent", () => {
    const dir = resolveImageDir(undefined, "/extension/dist", {
      config: { current: () => ({ models: { providers: {} } }) },
    }, {
      sessionKey: "workspace-a:run-1",
    });

    expect(dir).toBe("/extension/assets/profiles/workspace-a");
  });

  it("falls back to bundled assets without a profile workspace", () => {
    const dir = resolveImageDir(undefined, "/extension/dist", {
      config: { current: () => ({ models: { providers: {} } }) },
    });

    expect(dir).toBe("/extension/assets");
  });
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

   it("matches env var names with exact case (case-sensitive on Linux)", () => {
     process.env.MY_CUSTOM_VAR = "value";
     const result = expandEnvPlaceholder("${MY_CUSTOM_VAR}");
     expect(result).toBe("value");
     delete process.env.MY_CUSTOM_VAR;
   });
 });

describe("appendImageToMessage attachment schema", () => {
   it("uses newFileIndex=0 for new attachment placeholder ID", () => {
     const newFileIndex = 0;
     const filename = "emotion.png";
     const attachment = { id: newFileIndex, filename };
     expect(attachment.id).toBe(0);
     expect(attachment.filename).toBe("emotion.png");
   });

   it("preserves existing attachment snowflake IDs as strings", () => {
     const existingAttachments = [
       { id: "1234567890123456789", filename: "old1.png" },
       { id: "9876543210987654321", filename: "old2.png" },
     ];
     const preserved = existingAttachments.map((a) => ({ id: a.id }));
     expect(preserved[0].id).toBe("1234567890123456789");
     expect(preserved[1].id).toBe("9876543210987654321");
   });

   it("matches files[0] form key with id=0 for new upload", () => {
     const newFileIndex = 0;
     const formKey = `files[${newFileIndex}]`;
     expect(formKey).toBe("files[0]");
   });

   it("correctly builds attachment array with existing + new", () => {
     const existingAttachments = [{ id: "123456789" }];
     const newFileIndex = 0;
     const filename = "emotion.png";
     const attachments = [
       ...existingAttachments,
       { id: newFileIndex, filename },
     ];
     expect(attachments).toHaveLength(2);
     expect(attachments[0].id).toBe("123456789");
     expect(attachments[1].id).toBe(0);
     expect(attachments[1].filename).toBe("emotion.png");
   });
 });

describe("miracle mode", () => {
  describe("getCachedOrGenerateImage", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const mockRateLimiter = {
      canGenerate: vi.fn(() => true),
      recordGeneration: vi.fn(),
      getRemainingCount: vi.fn(() => 5),
      limit: 10,
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns cached variant buffer when available", async () => {
      const cachedBuffer = Buffer.from("CACHED_IMAGE");
      const variants = [{ filename: "happy.png", weight: 1, buffer: cachedBuffer }];

      const result = await getCachedOrGenerateImage(
        "happy",
        variants,
        false, // miracleMode disabled
        mockRateLimiter as any,
        {},
        mockLogger,
      );

      expect(result).toBe(cachedBuffer);
      expect(mockRateLimiter.canGenerate).not.toHaveBeenCalled();
    });

    it("returns null when no cached variant and miracle mode is disabled", async () => {
      const result = await getCachedOrGenerateImage(
        "excited",
        [], // no variants
        false, // miracleMode disabled
        mockRateLimiter as any,
        {},
        mockLogger,
      );

      expect(result).toBeNull();
      expect(mockRateLimiter.canGenerate).not.toHaveBeenCalled();
    });

    it("generates image when miracle mode is enabled and no cached variant", async () => {
      const generatedBuffer = Buffer.from("FAKE_CHEER_PNG");
      vi.mocked(generateImage).mockResolvedValueOnce(generatedBuffer);

      const result = await getCachedOrGenerateImage(
        "excited",
        [], // no variants
        true, // miracleMode enabled
        mockRateLimiter as any,
        { size: "1024x1024" },
        mockLogger,
      );

      expect(result).toBe(generatedBuffer);
      expect(mockRateLimiter.canGenerate).toHaveBeenCalled();
      expect(mockRateLimiter.recordGeneration).toHaveBeenCalled();
      expect(generateImage).toHaveBeenCalledWith({
        prompt: expect.stringContaining("excited"),
        size: "1024x1024",
      });
    });

    it("returns null when rate limit is exceeded", async () => {
      mockRateLimiter.canGenerate.mockReturnValueOnce(false);
      mockRateLimiter.getRemainingCount.mockReturnValueOnce(0);

      const result = await getCachedOrGenerateImage(
        "excited",
        [],
        true, // miracleMode enabled
        mockRateLimiter as any,
        {},
        mockLogger,
      );

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("rate limit reached"),
      );
      expect(generateImage).not.toHaveBeenCalled();
    });

    it("returns null when generation fails", async () => {
      vi.mocked(generateImage).mockRejectedValueOnce(new Error("API error"));

      const result = await getCachedOrGenerateImage(
        "excited",
        [],
        true, // miracleMode enabled
        mockRateLimiter as any,
        {},
        mockLogger,
      );

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("generation failed"),
      );
    });
  });

  describe("selectEmotionImageVariant with miracleMode parameter", () => {
    it("returns null when no variants and miracleMode is true", () => {
      const result = selectEmotionImageVariant([], Math.random, "", true);
      expect(result).toBeNull();
    });

    it("returns null when no variants and miracleMode is false", () => {
      const result = selectEmotionImageVariant([], Math.random, "", false);
      expect(result).toBeNull();
    });

    it("returns variant normally when variants exist regardless of miracleMode", () => {
      const variants = [{ filename: "happy.png", weight: 1 }];
      const result = selectEmotionImageVariant(variants, () => 0.5, "", true);
      expect(result).toEqual({ filename: "happy.png", weight: 1 });
    });
  });
});
