import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { EMOTIONS } from "./generator.js";

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

  beforeEach(() => {
    vi.mocked(generateImage).mockImplementation(async () =>
      Buffer.from("FAKE_PNG_DATA"),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("generates base + 6 emotion images when no baseImage provided", async () => {
    const results = await generateAllEmotions({
      character: "cute cat",
      outputDir: testDir,
    });

    expect(results.size).toBe(7);
    expect(results.has("base")).toBe(true);
    for (const emotion of EMOTIONS) {
      const filePath = results.get(emotion);
      expect(filePath).toBeDefined();
      expect(existsSync(filePath!)).toBe(true);
      const content = await readFile(filePath!);
      expect(content.toString()).toBe("FAKE_PNG_DATA");
    }
  });

  it("calls generateImage 7 times (1 base + 6 emotions) without baseImage", async () => {
    await generateAllEmotions({
      character: "pixel robot",
      outputDir: testDir,
    });

    const mock = vi.mocked(generateImage);
    expect(mock).toHaveBeenCalledTimes(7);

    const baseCall = mock.mock.calls[0][0];
    expect(baseCall.prompt).toContain("pixel robot");
    expect(baseCall.prompt).toContain("neutral pose");

    for (let i = 1; i <= EMOTIONS.length; i++) {
      const call = mock.mock.calls[i][0];
      expect(call.prompt).toContain("pixel robot");
      expect(call.prompt).toContain(EMOTIONS[i - 1]);
      expect(call.referenceImages).toHaveLength(1);
    }
  });

  it("skips base generation when baseImage is provided", async () => {
    const baseDir = join(testDir, "existing");
    await mkdir(baseDir, { recursive: true });
    const basePath = join(baseDir, "my-base.png");
    await writeFile(basePath, Buffer.from("EXISTING_BASE"));

    const results = await generateAllEmotions({
      character: "test",
      outputDir: testDir,
      baseImage: basePath,
    });

    const mock = vi.mocked(generateImage);
    expect(mock).toHaveBeenCalledTimes(6);
    expect(results.has("base")).toBe(false);
    expect(results.size).toBe(6);

    for (const call of mock.mock.calls) {
      expect(call[0].referenceImages).toHaveLength(1);
      expect(call[0].referenceImages![0]).toContain("RVhJU1RJTkdfQkFTRQ==");
    }
  });

  it("does not save base.png when keepBase is false", async () => {
    const results = await generateAllEmotions({
      character: "test",
      outputDir: testDir,
      keepBase: false,
    });

    expect(results.has("base")).toBe(false);
    expect(existsSync(resolve(testDir, "base.png"))).toBe(false);

    const mock = vi.mocked(generateImage);
    expect(mock).toHaveBeenCalledTimes(7);
  });

  it("passes model and size options to all generateImage calls", async () => {
    await generateAllEmotions({
      character: "test",
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
      character: "test",
      outputDir: testDir,
    });

    const mock = vi.mocked(generateImage);
    for (const call of mock.mock.calls) {
      expect(call[0].size).toBe("1024x1024");
    }
  });

  it("calls onProgress for base + each emotion", async () => {
    const progress: Array<{ step: string; index: number; total: number }> = [];

    await generateAllEmotions({
      character: "test",
      outputDir: testDir,
      onProgress(step, index, total) {
        progress.push({ step, index, total });
      },
    });

    expect(progress).toHaveLength(7);
    expect(progress[0].step).toBe("base");
    expect(progress[0].total).toBe(7);
    for (let i = 0; i < EMOTIONS.length; i++) {
      expect(progress[i + 1].step).toBe(EMOTIONS[i]);
      expect(progress[i + 1].index).toBe(i + 1);
    }
  });

  it("creates output directory if it does not exist", async () => {
    const nestedDir = join(testDir, "deep", "nested", "dir");
    expect(existsSync(nestedDir)).toBe(false);

    await generateAllEmotions({
      character: "test",
      outputDir: nestedDir,
    });

    expect(existsSync(nestedDir)).toBe(true);
  });

  it("writes files named after each emotion", async () => {
    await generateAllEmotions({
      character: "test",
      outputDir: testDir,
    });

    for (const emotion of EMOTIONS) {
      expect(existsSync(resolve(testDir, `${emotion}.png`))).toBe(true);
    }
  });

  it("saves base.png to output directory by default", async () => {
    await generateAllEmotions({
      character: "test",
      outputDir: testDir,
    });

    expect(existsSync(resolve(testDir, "base.png"))).toBe(true);
    const content = await readFile(resolve(testDir, "base.png"));
    expect(content.toString()).toBe("FAKE_PNG_DATA");
  });

  it("generates only requested emotions and reports adjusted progress totals", async () => {
    const progress: Array<{ step: string; index: number; total: number }> = [];

    const results = await generateAllEmotions({
      character: "test",
      outputDir: testDir,
      only: ["happy", "focused"],
      onProgress(step, index, total) {
        progress.push({ step, index, total });
      },
    });

    expect(results.size).toBe(3);
    expect(results.has("base")).toBe(true);
    expect(results.has("happy")).toBe(true);
    expect(results.has("focused")).toBe(true);
    expect(results.has("neutral")).toBe(false);
    expect(progress.map((entry) => entry.step)).toEqual(["base", "happy", "focused"]);
    expect(progress.every((entry) => entry.total === 3)).toBe(true);
  });

  it("writes no files when a later emotion generation fails (atomic all-or-nothing)", async () => {
    let calls = 0;
    vi.mocked(generateImage).mockImplementation(async () => {
      calls += 1;
      // base (1) + first two emotions (2,3) succeed; the next call fails.
      if (calls >= 4) {
        throw new Error("simulated generation failure");
      }
      return Buffer.from("FAKE_PNG_DATA");
    });

    await expect(
      generateAllEmotions({ character: "cute cat", outputDir: testDir }),
    ).rejects.toThrow("simulated generation failure");

    // Atomic: a mid-run failure must leave the output directory with no
    // partial/old-mixed emotion set.
    expect(existsSync(resolve(testDir, "base.png"))).toBe(false);
    for (const emotion of EMOTIONS) {
      expect(existsSync(resolve(testDir, `${emotion}.png`))).toBe(false);
    }
  });
});
