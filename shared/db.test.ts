import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileDatabase } from "./db.js";

let tmpDir: string;
let db: ProfileDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hentai-db-test-"));
  db = new ProfileDatabase(tmpDir);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("DB initialization", () => {
  it("creates hentai.db in the given directory", () => {
    const { existsSync } = require("node:fs");
    expect(existsSync(join(tmpDir, "hentai.db"))).toBe(true);
  });

  it("re-opens an existing DB without error", () => {
    db.close();
    const db2 = new ProfileDatabase(tmpDir);
    expect(db2.listProfiles()).toEqual([]);
    db2.close();
  });

  it("auto-creates directory if missing", () => {
    const nested = join(tmpDir, "sub", "deep");
    const db2 = new ProfileDatabase(nested);
    expect(db2.listProfiles()).toEqual([]);
    db2.close();
  });
});

describe("profile CRUD", () => {
  it("creates and retrieves a profile", () => {
    const profile = db.createProfile({ id: "gothic", name: "Gothic" });
    expect(profile.id).toBe("gothic");
    expect(profile.name).toBe("Gothic");
    expect(profile.character).toBeNull();
    expect(profile.soulSnippet).toBeNull();
    expect(profile.createdAt).toBeTruthy();

    const fetched = db.getProfile("gothic");
    expect(fetched).toEqual(profile);
  });

  it("creates a profile with all fields", () => {
    const profile = db.createProfile({
      id: "cute-cat",
      name: "Cute Cat",
      character: "orange tabby cat",
      soulSnippet: "speaks in uwu language",
      model: "gpt-5.4",
    });
    expect(profile.character).toBe("orange tabby cat");
    expect(profile.soulSnippet).toBe("speaks in uwu language");
    expect(profile.model).toBe("gpt-5.4");
  });

  it("throws on duplicate ID", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    expect(() => db.createProfile({ id: "gothic", name: "Gothic 2" })).toThrow();
  });

  it("throws on invalid ID", () => {
    expect(() => db.createProfile({ id: "../bad", name: "Bad" })).toThrow(
      'Invalid profile ID: "../bad"',
    );
    expect(() => db.createProfile({ id: "", name: "Empty" })).toThrow();
  });

  it("updates a profile", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    const updated = db.updateProfile("gothic", { soulSnippet: "cold tone" });
    expect(updated.soulSnippet).toBe("cold tone");
    expect(updated.name).toBe("Gothic");
    expect(updated.updatedAt).toBeTruthy();
  });

  it("updates name only", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    const updated = db.updateProfile("gothic", { name: "Dark Gothic" });
    expect(updated.name).toBe("Dark Gothic");
  });

  it("clears a field by setting null", () => {
    db.createProfile({
      id: "gothic",
      name: "Gothic",
      soulSnippet: "cold tone",
    });
    const updated = db.updateProfile("gothic", { soulSnippet: null });
    expect(updated.soulSnippet).toBeNull();
  });

  it("throws when updating nonexistent profile", () => {
    expect(() => db.updateProfile("nope", { name: "X" })).toThrow(
      'Profile not found: "nope"',
    );
  });

  it("no-op update returns existing profile", () => {
    const created = db.createProfile({ id: "gothic", name: "Gothic" });
    const same = db.updateProfile("gothic", {});
    expect(same.id).toBe(created.id);
  });

  it("deletes a profile", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    expect(db.deleteProfile("gothic")).toBe(true);
    expect(db.getProfile("gothic")).toBeNull();
  });

  it("returns false when deleting nonexistent", () => {
    expect(db.deleteProfile("nope")).toBe(false);
  });

  it("lists profiles in creation order", () => {
    db.createProfile({ id: "alpha", name: "Alpha" });
    db.createProfile({ id: "beta", name: "Beta" });
    const list = db.listProfiles();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("alpha");
    expect(list[1].id).toBe("beta");
  });

  it("getProfile returns null for unknown ID", () => {
    expect(db.getProfile("unknown")).toBeNull();
  });
});

describe("channel mapping", () => {
  beforeEach(() => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    db.createProfile({ id: "cute", name: "Cute" });
  });

  it("sets and gets a channel profile", () => {
    db.setChannelProfile("ch-123", "gothic");
    expect(db.getChannelProfile("ch-123")).toBe("gothic");
  });

  it("overwrites existing channel mapping", () => {
    db.setChannelProfile("ch-123", "gothic");
    db.setChannelProfile("ch-123", "cute");
    expect(db.getChannelProfile("ch-123")).toBe("cute");
  });

  it("returns null for unmapped channel", () => {
    expect(db.getChannelProfile("unmapped")).toBeNull();
  });

  it("removes a channel mapping", () => {
    db.setChannelProfile("ch-123", "gothic");
    expect(db.removeChannelProfile("ch-123")).toBe(true);
    expect(db.getChannelProfile("ch-123")).toBeNull();
  });

  it("returns false when removing unmapped channel", () => {
    expect(db.removeChannelProfile("unmapped")).toBe(false);
  });

  it("throws when mapping to nonexistent profile", () => {
    expect(() => db.setChannelProfile("ch-123", "nonexistent")).toThrow(
      'Profile not found: "nonexistent"',
    );
  });

  it("cascades on profile delete", () => {
    db.setChannelProfile("ch-123", "gothic");
    db.setChannelProfile("ch-456", "gothic");
    db.deleteProfile("gothic");
    expect(db.getChannelProfile("ch-123")).toBeNull();
    expect(db.getChannelProfile("ch-456")).toBeNull();
  });

  it("lists all channel mappings", () => {
    db.setChannelProfile("ch-aaa", "gothic");
    db.setChannelProfile("ch-bbb", "cute");
    const list = db.listChannelProfiles();
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.channelId).sort()).toEqual(["ch-aaa", "ch-bbb"]);
  });
});

describe("profile settings", () => {
  beforeEach(() => {
    db.createProfile({ id: "gothic", name: "Gothic" });
  });

  it("sets and gets a setting", () => {
    db.setProfileSetting("gothic", "theme", "dark");
    expect(db.getProfileSetting("gothic", "theme")).toBe("dark");
  });

  it("overwrites a setting", () => {
    db.setProfileSetting("gothic", "theme", "dark");
    db.setProfileSetting("gothic", "theme", "light");
    expect(db.getProfileSetting("gothic", "theme")).toBe("light");
  });

  it("returns null for missing setting", () => {
    expect(db.getProfileSetting("gothic", "missing")).toBeNull();
  });

  it("cascades on profile delete", () => {
    db.setProfileSetting("gothic", "theme", "dark");
    db.deleteProfile("gothic");
    expect(db.getProfileSetting("gothic", "theme")).toBeNull();
  });
});
