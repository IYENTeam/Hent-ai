import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
  throw new Error(`process.exit(${code})`);
});

const { runSets } = await import("./sets.js");

describe("sets manifest handling", () => {
  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockClear();
  });

  it("creates an empty manifest when manifest.json is truly absent", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "hent-ai-sets-absent-"));
    try {
      await runSets(["list", "--dir", assetDir]);
      const manifest = JSON.parse(await readFile(join(assetDir, "manifest.json"), "utf-8"));
      expect(manifest).toEqual({ version: 1, activeSet: "", sets: {} });
    } finally {
      await rm(assetDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a corrupt manifest with an empty registry", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "hent-ai-sets-corrupt-"));
    try {
      const manifestPath = join(assetDir, "manifest.json");
      await writeFile(manifestPath, "{ truncated", "utf-8");
      await expect(runSets(["list", "--dir", assetDir])).rejects.toThrow(SyntaxError);
      await expect(readFile(manifestPath, "utf-8")).resolves.toBe("{ truncated");
    } finally {
      await rm(assetDir, { recursive: true, force: true });
    }
  });
});
