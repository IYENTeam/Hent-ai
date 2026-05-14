import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { EMOTIONS, type Emotion } from "./generator.js";

vi.mock("./codex.js", () => ({
  generateImage: vi.fn(async () => {
    return Buffer.from("FAKE_PNG_DATA");
  }),
}));

const { generateAllEmotions } = await import("./generator.js");
const { generateImage } = await import("./codex.js");

describe("EMOTIONS", () => {
  it("contains exactly 6 emotions", () => {
    expect(EMOTIONS).toHaveLength(6);
  });

  it("includes all required emotions", () => {
    expect(EMOTIONS).toContain("happy");
    expect(EMOTIONS).toContain("neutral");
    expect(EMOTIONS).toContain("loyalty");
    expect(EMOTIONS).toContain("sorry");
    expect(EMOTIONS).toContain("confused");
    expect(EMOTIONS).toContain("focused");
  });
});

describe("generateAllEmotions", () => {
  const testDir = join(tmpdir(), `hent-ai-test-${Date.now()}`);

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("generates one image per emotion and saves to output directory", async () => {
    const results = await generateAllEmotions({
      prompt: "cute cat",
      outputDir: testDir,
    });

    expect(results.size).toBe(6);
    for (const emotion of EMOTIONS) {
      const filePath = results.get(emotion);
      expect(filePath).toBeDefined();
      expect(existsSync(filePath!)).toBe(true);
      const content = await readFile(filePath!);
      expect(content.toString()).toBe("FAKE_PNG_DATA");
    }
  });

  it("calls generateImage with emotion-specific prompts", async () => {
    await generateAllEmotions({
      prompt: "pixel robot",
      outputDir: testDir,
    });

    const mock = vi.mocked(generateImage);
    expect(mock).toHaveBeenCalledTimes(6);

    for (let i = 0; i < EMOTIONS.length; i++) {
      const call = mock.mock.calls[i][0];
      expect(call.prompt).toContain("pixel robot");
      expect(call.prompt).toContain(EMOTIONS[i]);
    }
  });

  it("passes model and size options to generateImage", async () => {
    await generateAllEmotions({
      prompt: "test",
      outputDir: testDir,
      model: "gpt-5.4",
      size: "2048x2048",
    });

    const mock = vi.mocked(generateImage);
    for (const call of mock.mock.calls) {
      expect(call[0].model).toBe("gpt-5.4");
      expect(call[0].size).toBe("2048x2048");
    }
  });

  it("uses 1024x1024 as default size", async () => {
    await generateAllEmotions({
      prompt: "test",
      outputDir: testDir,
    });

    const mock = vi.mocked(generateImage);
    for (const call of mock.mock.calls) {
      expect(call[0].size).toBe("1024x1024");
    }
  });

  it("passes reference image when provided", async () => {
    const refDataUrl = "data:image/png;base64,AAAA";
    await generateAllEmotions({
      prompt: "test",
      outputDir: testDir,
      referenceImage: refDataUrl,
    });

    const mock = vi.mocked(generateImage);
    for (const call of mock.mock.calls) {
      expect(call[0].referenceImages).toEqual([refDataUrl]);
    }
  });

  it("calls onProgress for each emotion", async () => {
    const progress: Array<{ emotion: Emotion; index: number; total: number }> = [];

    await generateAllEmotions({
      prompt: "test",
      outputDir: testDir,
      onProgress(emotion, index, total) {
        progress.push({ emotion, index, total });
      },
    });

    expect(progress).toHaveLength(6);
    for (let i = 0; i < EMOTIONS.length; i++) {
      expect(progress[i].emotion).toBe(EMOTIONS[i]);
      expect(progress[i].index).toBe(i);
      expect(progress[i].total).toBe(6);
    }
  });

  it("creates output directory if it does not exist", async () => {
    const nestedDir = join(testDir, "deep", "nested", "dir");
    expect(existsSync(nestedDir)).toBe(false);

    await generateAllEmotions({
      prompt: "test",
      outputDir: nestedDir,
    });

    expect(existsSync(nestedDir)).toBe(true);
  });

  it("writes files named after each emotion", async () => {
    await generateAllEmotions({
      prompt: "test",
      outputDir: testDir,
    });

    for (const emotion of EMOTIONS) {
      expect(existsSync(resolve(testDir, `${emotion}.png`))).toBe(true);
    }
  });
});
