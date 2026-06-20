import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmptyManifest,
  loadManifest,
  loadManifestSync,
  saveManifest,
  getActiveSet,
  buildEmotionMapFromSet,
  registerSet,
  activateSet,
  listSets,
  addFilesToSet,
  getSetDir,
  type AssetManifest,
} from "./manifest.js";
import { existsSync } from "node:fs";

describe("manifest", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hent-ai-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("createEmptyManifest", () => {
    it("creates a valid empty manifest", () => {
      const m = createEmptyManifest();
      expect(m.version).toBe(1);
      expect(m.activeSet).toBe("");
      expect(m.sets).toEqual({});
    });
  });

  describe("loadManifest / saveManifest", () => {
    it("returns null when no manifest exists", async () => {
      expect(await loadManifest(tempDir)).toBeNull();
    });

    it("round-trips a manifest", async () => {
      const m = createEmptyManifest();
      m.activeSet = "test-set";
      m.sets["test-set"] = {
        name: "Test",
        createdAt: "2026-01-01T00:00:00Z",
        emotions: { happy: ["happy.png"] },
      };
      await saveManifest(tempDir, m);
      const loaded = await loadManifest(tempDir);
      expect(loaded).toEqual(m);
    });

    it("throws on corrupt manifest instead of treating it as missing", async () => {
      await writeFile(join(tempDir, "manifest.json"), "{ truncated", "utf-8");
      await expect(loadManifest(tempDir)).rejects.toThrow(SyntaxError);
    });

    it("writes manifest atomically without leaving temp files", async () => {
      const m = createEmptyManifest();
      m.activeSet = "atomic-test";
      await saveManifest(tempDir, m);
      expect(await loadManifest(tempDir)).toEqual(m);
      const files = await readdir(tempDir);
      expect(files).toContain("manifest.json");
      expect(files.filter((file) => file.startsWith("manifest.json.tmp-"))).toEqual([]);
    });
  });

  describe("loadManifestSync", () => {
    it("returns null when no manifest exists", () => {
      expect(loadManifestSync(tempDir)).toBeNull();
    });

    it("reads saved manifest", async () => {
      const m = createEmptyManifest();
      m.activeSet = "sync-test";
      m.sets["sync-test"] = {
        name: "Sync",
        createdAt: "2026-01-01T00:00:00Z",
        emotions: { neutral: ["neutral.png"] },
      };
      await saveManifest(tempDir, m);
      const loaded = loadManifestSync(tempDir);
      expect(loaded).toEqual(m);
    });

    it("throws on corrupt manifest instead of treating it as missing", async () => {
      await writeFile(join(tempDir, "manifest.json"), "{ truncated", "utf-8");
      expect(() => loadManifestSync(tempDir)).toThrow(SyntaxError);
    });
  });

  describe("getActiveSet", () => {
    it("returns null when activeSet is empty", () => {
      const m = createEmptyManifest();
      expect(getActiveSet(m)).toBeNull();
    });

    it("returns the active set", () => {
      const m = createEmptyManifest();
      m.activeSet = "s1";
      m.sets["s1"] = {
        name: "Set 1",
        createdAt: "2026-01-01T00:00:00Z",
        emotions: { happy: ["happy.png"] },
      };
      const active = getActiveSet(m);
      expect(active?.id).toBe("s1");
      expect(active?.set.name).toBe("Set 1");
    });
  });

  describe("buildEmotionMapFromSet", () => {
    it("produces file paths relative to sets directory", () => {
      const set = {
        name: "Test",
        createdAt: "2026-01-01T00:00:00Z",
        emotions: {
          happy: ["happy.png", "happy-v2.png"],
          sad: ["sad.png"],
        },
      };
      const map = buildEmotionMapFromSet("my-set", set);
      expect(map.happy).toEqual([
        { file: "sets/my-set/happy.png", weight: 1 },
        { file: "sets/my-set/happy-v2.png", weight: 1 },
      ]);
      expect(map.sad).toEqual([
        { file: "sets/my-set/sad.png", weight: 1 },
      ]);
    });
  });

  describe("registerSet", () => {
    it("scans a directory and registers emotions", async () => {
      const m = createEmptyManifest();
      const setDir = getSetDir(tempDir, "test-set");
      await mkdir(setDir, { recursive: true });
      await writeFile(join(setDir, "happy.png"), "fake");
      await writeFile(join(setDir, "neutral.png"), "fake");
      await writeFile(join(setDir, "base.png"), "fake"); // should be excluded
      await writeFile(join(setDir, "readme.txt"), "fake"); // should be excluded

      const set = await registerSet(tempDir, m, "test-set", {
        name: "Test Set",
        character: "cute cat",
      });

      expect(set.name).toBe("Test Set");
      expect(set.character).toBe("cute cat");
      expect(set.emotions.happy).toEqual(["happy.png"]);
      expect(set.emotions.neutral).toEqual(["neutral.png"]);
      expect(set.emotions.base).toBeUndefined(); // base excluded
      expect(m.sets["test-set"]).toBe(set);
    });

    it("detects variant files", async () => {
      const m = createEmptyManifest();
      const setDir = getSetDir(tempDir, "variants");
      await mkdir(setDir, { recursive: true });
      await writeFile(join(setDir, "happy.png"), "fake");
      await writeFile(join(setDir, "happy-alt.png"), "fake");
      await writeFile(join(setDir, "happy_v2.png"), "fake");

      const set = await registerSet(tempDir, m, "variants", { name: "V" });
      expect(set.emotions.happy).toHaveLength(3);
      expect(set.emotions.happy).toContain("happy.png");
      expect(set.emotions.happy).toContain("happy-alt.png");
      expect(set.emotions.happy).toContain("happy_v2.png");
    });
  });

  describe("activateSet", () => {
    it("copies files to root and updates activeSet", async () => {
      const m = createEmptyManifest();
      const setDir = getSetDir(tempDir, "s1");
      await mkdir(setDir, { recursive: true });
      await writeFile(join(setDir, "happy.png"), "happy-data");
      await writeFile(join(setDir, "base.png"), "base-data");

      m.sets["s1"] = {
        name: "S1",
        createdAt: "2026-01-01T00:00:00Z",
        emotions: { happy: ["happy.png"] },
      };

      await activateSet(tempDir, m, "s1");
      expect(m.activeSet).toBe("s1");
      expect(existsSync(join(tempDir, "happy.png"))).toBe(true);
      expect(existsSync(join(tempDir, "base.png"))).toBe(true);
    });
  });

  describe("listSets", () => {
    it("returns summary of all sets", () => {
      const m = createEmptyManifest();
      m.activeSet = "s1";
      m.sets["s1"] = {
        name: "Set 1",
        createdAt: "2026-01-01",
        emotions: { happy: ["a.png", "b.png"], sad: ["c.png"] },
      };
      m.sets["s2"] = {
        name: "Set 2",
        createdAt: "2026-02-01",
        emotions: { happy: ["x.png"] },
      };

      const list = listSets(m);
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe("s1");
      expect(list[0].active).toBe(true);
      expect(list[0].totalFiles).toBe(3);
      expect(list[1].active).toBe(false);
    });
  });

  describe("addFilesToSet", () => {
    it("adds files to an emotion", async () => {
      const m = createEmptyManifest();
      m.sets["s1"] = {
        name: "S1",
        createdAt: "2026-01-01",
        emotions: { happy: ["happy.png"] },
      };

      await addFilesToSet(tempDir, m, "s1", "happy", ["happy-v2.png"]);
      expect(m.sets["s1"].emotions.happy).toEqual(["happy.png", "happy-v2.png"]);

      // no duplicates
      await addFilesToSet(tempDir, m, "s1", "happy", ["happy-v2.png"]);
      expect(m.sets["s1"].emotions.happy).toHaveLength(2);
    });

    it("creates new emotion if not exists", async () => {
      const m = createEmptyManifest();
      m.sets["s1"] = {
        name: "S1",
        createdAt: "2026-01-01",
        emotions: {},
      };

      await addFilesToSet(tempDir, m, "s1", "nervous", ["nervous.png"]);
      expect(m.sets["s1"].emotions.nervous).toEqual(["nervous.png"]);
    });
  });
});
