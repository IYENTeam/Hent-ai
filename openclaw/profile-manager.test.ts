import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileDatabase } from "@hent-ai/shared/db";
import {
  getProfileImageDir,
  resolveActiveProfileId,
  resolveProfileImageDirForChannel,
  createProfile,
  switchChannelProfile,
  listProfiles,
  getProfile,
  updateProfile,
  deleteProfile,
} from "./profile-manager.js";

let tmpDir: string;
let db: ProfileDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pm-test-"));
  db = new ProfileDatabase(tmpDir);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getProfileImageDir", () => {
  it("returns profiles subdirectory path", () => {
    const result = getProfileImageDir("/img", "gothic");
    expect(result).toMatch(/profiles[/\\]gothic$/);
  });
});

describe("resolveActiveProfileId", () => {
  it("returns channel-mapped profile", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    db.setChannelProfile("ch1", "gothic");
    expect(resolveActiveProfileId(db, "ch1", undefined)).toBe("gothic");
  });

  it("falls back to default when channel not mapped", () => {
    expect(resolveActiveProfileId(db, "ch1", "fallback")).toBe("fallback");
  });

  it("returns null when no channel and no default", () => {
    expect(resolveActiveProfileId(db, undefined, undefined)).toBeNull();
  });

  it("prefers channel mapping over default", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    db.createProfile({ id: "cute", name: "Cute" });
    db.setChannelProfile("ch1", "gothic");
    expect(resolveActiveProfileId(db, "ch1", "cute")).toBe("gothic");
  });
});

describe("resolveProfileImageDirForChannel", () => {
  it("returns profile dir when it exists", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    db.setChannelProfile("ch1", "gothic");
    const profileDir = getProfileImageDir(tmpDir, "gothic");
    mkdirSync(profileDir, { recursive: true });

    const result = resolveProfileImageDirForChannel(tmpDir, db, "ch1", undefined);
    expect(result).toBe(profileDir);
  });

  it("falls back to imageDir when profile dir missing", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    db.setChannelProfile("ch1", "gothic");

    const result = resolveProfileImageDirForChannel(tmpDir, db, "ch1", undefined);
    expect(result).toBe(tmpDir);
  });

  it("returns imageDir when no profile resolved", () => {
    const result = resolveProfileImageDirForChannel(tmpDir, db, undefined, undefined);
    expect(result).toBe(tmpDir);
  });
});

describe("CRUD wrappers", () => {
  it("createProfile and getProfile", () => {
    const p = createProfile(db, { id: "gothic", name: "Gothic" });
    expect(p.id).toBe("gothic");
    expect(getProfile(db, "gothic")?.name).toBe("Gothic");
  });

  it("listProfiles", () => {
    createProfile(db, { id: "a", name: "A" });
    createProfile(db, { id: "b", name: "B" });
    expect(listProfiles(db)).toHaveLength(2);
  });

  it("updateProfile", () => {
    createProfile(db, { id: "gothic", name: "Gothic" });
    const updated = updateProfile(db, "gothic", { name: "Dark Gothic" });
    expect(updated.name).toBe("Dark Gothic");
  });

  it("deleteProfile", () => {
    createProfile(db, { id: "gothic", name: "Gothic" });
    expect(deleteProfile(db, "gothic")).toBe(true);
    expect(getProfile(db, "gothic")).toBeNull();
  });

  it("switchChannelProfile", () => {
    createProfile(db, { id: "gothic", name: "Gothic" });
    switchChannelProfile(db, "ch1", "gothic");
    expect(db.getChannelProfile("ch1")).toBe("gothic");
  });
});
