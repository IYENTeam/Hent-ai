import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./codex.js", () => ({
  generateImage: vi.fn(async () => Buffer.from("FAKE_PNG_DATA")),
  CodexHttpError: class CodexHttpError extends Error {
    constructor(public readonly statusCode: number, message: string) {
      super(message);
      this.name = "CodexHttpError";
    }
  },
  CodexTimeoutError: class CodexTimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CodexTimeoutError";
    }
  },
}));

const { generateAllEmotions } = await import("./generator.js");
const { generateImage, CodexHttpError } = await import("./codex.js");

describe("generateAllEmotions concurrency", () => {
  const testDir = join(tmpdir(), `hent-ai-concurrency-${Date.now()}`);

  beforeEach(() => {
    vi.mocked(generateImage).mockImplementation(async () =>
      Buffer.from("FAKE_PNG_DATA"),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it("generates emotion variants in bounded parallel batches", async () => {
    let inFlightEmotionCalls = 0;
    let maxInFlightEmotionCalls = 0;

    vi.mocked(generateImage).mockImplementation(async (options) => {
      if (options.referenceImages?.length) {
        inFlightEmotionCalls += 1;
        maxInFlightEmotionCalls = Math.max(maxInFlightEmotionCalls, inFlightEmotionCalls);
        await Promise.resolve();
        inFlightEmotionCalls -= 1;
      }
      return Buffer.from("FAKE_PNG_DATA");
    });

    await generateAllEmotions({
      character: "test",
      outputDir: testDir,
      only: ["happy", "neutral", "loyalty", "sorry"],
      concurrency: 2,
    });

    expect(maxInFlightEmotionCalls).toBe(2);
  });

  it("retries retryable CodexHttpError in auto concurrency mode", async () => {
    const attemptsByPrompt = new Map<string, number>();

    vi.mocked(generateImage).mockImplementation(async (options) => {
      if (options.referenceImages?.length) {
        const previousAttempts = attemptsByPrompt.get(options.prompt) ?? 0;
        attemptsByPrompt.set(options.prompt, previousAttempts + 1);
        if (options.prompt.includes("happy") && previousAttempts === 0) {
          throw new CodexHttpError(429, "Codex backend returned HTTP 429: rate limit");
        }
      }
      return Buffer.from("FAKE_PNG_DATA");
    });

    const results = await generateAllEmotions({
      character: "test",
      outputDir: testDir,
      only: ["happy", "neutral"],
      concurrency: "auto",
      retryDelayMs: 0,
      retryJitterMs: 0,
      initialJitterMs: 0,
    });

    expect(results.has("happy")).toBe(true);
    expect(results.has("neutral")).toBe(true);
    const happyAttempts = [...attemptsByPrompt.entries()]
      .filter(([prompt]) => prompt.includes("happy"))
      .map(([_prompt, attempts]) => attempts);
    expect(happyAttempts).toEqual([2]);
  });
});
