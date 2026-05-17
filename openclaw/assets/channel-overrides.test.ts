import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  loadChannelOverridesSync,
  loadChannelOverrides,
  saveChannelOverrides,
} from "./channel-overrides.js";

describe("channel-overrides", () => {
  const dirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hent-overrides-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
  });

  describe("loadChannelOverridesSync", () => {
    it("returns empty object when file does not exist", () => {
      const dir = makeTmpDir();
      expect(loadChannelOverridesSync(dir)).toEqual({});
    });

    it("reads existing overrides", () => {
      const dir = makeTmpDir();
      const data = { "123": "private", "456": "gothic" };
      writeFileSync(join(dir, "channel-overrides.json"), JSON.stringify(data));
      expect(loadChannelOverridesSync(dir)).toEqual(data);
    });

    it("returns empty object on malformed JSON", () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, "channel-overrides.json"), "not json");
      expect(loadChannelOverridesSync(dir)).toEqual({});
    });
  });

  describe("loadChannelOverrides (async)", () => {
    it("returns empty object when file does not exist", async () => {
      const dir = makeTmpDir();
      expect(await loadChannelOverrides(dir)).toEqual({});
    });

    it("reads existing overrides", async () => {
      const dir = makeTmpDir();
      const data = { "789": "private" };
      writeFileSync(join(dir, "channel-overrides.json"), JSON.stringify(data));
      expect(await loadChannelOverrides(dir)).toEqual(data);
    });
  });

  describe("saveChannelOverrides", () => {
    it("writes overrides to disk", async () => {
      const dir = makeTmpDir();
      await saveChannelOverrides(dir, { "111": "private" });

      const raw = readFileSync(join(dir, "channel-overrides.json"), "utf-8");
      expect(JSON.parse(raw)).toEqual({ "111": "private" });
    });

    it("overwrites existing file", async () => {
      const dir = makeTmpDir();
      await saveChannelOverrides(dir, { "111": "a" });
      await saveChannelOverrides(dir, { "222": "b" });

      const raw = readFileSync(join(dir, "channel-overrides.json"), "utf-8");
      expect(JSON.parse(raw)).toEqual({ "222": "b" });
    });
  });

  describe("roundtrip", () => {
    it("save then load returns same data", async () => {
      const dir = makeTmpDir();
      const data = { "100": "private", "200": "default", "300": "gothic-v2" };
      await saveChannelOverrides(dir, data);
      expect(loadChannelOverridesSync(dir)).toEqual(data);
      expect(await loadChannelOverrides(dir)).toEqual(data);
    });
  });
});
