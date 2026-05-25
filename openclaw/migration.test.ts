import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProfileDatabase } from "@hent-ai/shared/db";
import { runMigration } from "./migration.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migration-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeDummyPng(dir: string, filename: string): void {
  writeFileSync(resolve(dir, filename), Buffer.from([0x89, 0x50]));
}

function writeDummyEmotions(dir: string): void {
  for (const f of ["happy.png", "neutral.png", "loyalty.png", "sorry.png", "confused.png", "focused.png"]) {
    writeDummyPng(dir, f);
  }
}

describe("runMigration — flat assets", () => {
  it("migrates flat emotion files to profiles/default/", () => {
    writeDummyEmotions(tmpDir);

    const result = runMigration(tmpDir);

    expect(result.skipped).toBe(false);
    expect(result.flatAssetsMigrated).toBe(true);
    expect(existsSync(resolve(tmpDir, "profiles", "default", "happy.png"))).toBe(true);
    expect(existsSync(resolve(tmpDir, "profiles", "default", "focused.png"))).toBe(true);

    const db = new ProfileDatabase(tmpDir);
    try {
      const profile = db.getProfile("default");
      expect(profile).not.toBeNull();
      expect(profile!.name).toBe("Default");
    } finally {
      db.close();
    }
  });

  it("also copies base.png if present", () => {
    writeDummyEmotions(tmpDir);
    writeDummyPng(tmpDir, "base.png");

    runMigration(tmpDir);

    expect(existsSync(resolve(tmpDir, "profiles", "default", "base.png"))).toBe(true);
  });

  it("does not migrate when no emotion files exist", () => {
    const result = runMigration(tmpDir);
    expect(result.flatAssetsMigrated).toBe(false);
  });
});

describe("runMigration — manifest sets", () => {
  it("migrates manifest sets to profiles", () => {
    const setsDir = resolve(tmpDir, "sets", "gothic-v1");
    mkdirSync(setsDir, { recursive: true });
    writeDummyPng(setsDir, "happy.png");
    writeDummyPng(setsDir, "neutral.png");

    const manifest = {
      version: 1,
      activeSet: "gothic-v1",
      sets: {
        "gothic-v1": {
          name: "Gothic V1",
          character: "dark girl",
          createdAt: "2024-01-01T00:00:00Z",
          emotions: { happy: ["happy.png"], neutral: ["neutral.png"] },
        },
      },
    };
    writeFileSync(resolve(tmpDir, "manifest.json"), JSON.stringify(manifest));

    const result = runMigration(tmpDir);

    expect(result.setsMigrated).toBe(1);
    expect(existsSync(resolve(tmpDir, "profiles", "gothic-v1", "happy.png"))).toBe(true);

    const db = new ProfileDatabase(tmpDir);
    try {
      const profile = db.getProfile("gothic-v1");
      expect(profile).not.toBeNull();
      expect(profile!.name).toBe("Gothic V1");
      expect(profile!.character).toBe("dark girl");
    } finally {
      db.close();
    }
  });
});

describe("runMigration — channel overrides", () => {
  it("migrates channel overrides to DB", () => {
    writeDummyEmotions(tmpDir);

    const setsDir = resolve(tmpDir, "sets", "private");
    mkdirSync(setsDir, { recursive: true });
    writeDummyPng(setsDir, "happy.png");

    const manifest = {
      version: 1,
      activeSet: "private",
      sets: {
        private: {
          name: "Private",
          createdAt: "2024-01-01T00:00:00Z",
          emotions: { happy: ["happy.png"] },
        },
      },
    };
    writeFileSync(resolve(tmpDir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      resolve(tmpDir, "channel-overrides.json"),
      JSON.stringify({ "ch-123": "private" }),
    );

    const result = runMigration(tmpDir);

    expect(result.channelOverridesMigrated).toBe(1);

    const db = new ProfileDatabase(tmpDir);
    try {
      expect(db.getChannelAssetSet("ch-123")).toBe("private");
      expect(db.getChannelProfile("ch-123")).toBe("private");
    } finally {
      db.close();
    }
  });
});

describe("runMigration — skip conditions", () => {
  it("skips when marker file exists", () => {
    writeDummyEmotions(tmpDir);
    writeFileSync(resolve(tmpDir, ".migrated-to-profiles"), "done");

    const result = runMigration(tmpDir);
    expect(result.skipped).toBe(true);
  });

  it("skips when profiles/ directory already exists", () => {
    writeDummyEmotions(tmpDir);
    mkdirSync(resolve(tmpDir, "profiles"), { recursive: true });

    const result = runMigration(tmpDir);
    expect(result.skipped).toBe(true);
  });

  it("is idempotent — second run is a no-op", () => {
    writeDummyEmotions(tmpDir);

    const first = runMigration(tmpDir);
    expect(first.skipped).toBe(false);

    const second = runMigration(tmpDir);
    expect(second.skipped).toBe(true);
  });
});
