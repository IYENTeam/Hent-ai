import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileDatabase } from "@hent-ai/shared/db";
import {
  buildDynamicPrompt,
  getSoulSnippetForChannel,
  getProfileModeForChannel,
  appendPersonaToPrompt,
} from "./dynamic-persona.js";

let tmpDir: string;
let db: ProfileDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dp-test-"));
  db = new ProfileDatabase(tmpDir);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildDynamicPrompt", () => {
  it("appends snippet with separator", () => {
    const result = buildDynamicPrompt("You are helpful.", "cold and aloof tone");
    expect(result).toBe("You are helpful.\n\n--- Hent-ai Character ---\ncold and aloof tone");
  });

  it("returns base prompt when snippet is null", () => {
    expect(buildDynamicPrompt("base", null)).toBe("base");
  });

  it("returns base prompt when snippet is empty string", () => {
    expect(buildDynamicPrompt("base", "")).toBe("base");
  });

  it("returns base prompt when snippet is whitespace only", () => {
    expect(buildDynamicPrompt("base", "   \n  ")).toBe("base");
  });

  it("trims snippet whitespace", () => {
    const result = buildDynamicPrompt("base", "  hello  ");
    expect(result).toContain("hello");
    expect(result).not.toContain("  hello  ");
  });
});

describe("getSoulSnippetForChannel", () => {
  it("returns snippet for mapped channel", () => {
    db.createProfile({ id: "gothic", name: "Gothic", soulSnippet: "dark tone" });
    db.setChannelProfile("ch1", "gothic");
    expect(getSoulSnippetForChannel(db, "ch1", undefined)).toBe("dark tone");
  });

  it("falls back to default profile", () => {
    db.createProfile({ id: "default", name: "Default", soulSnippet: "friendly" });
    expect(getSoulSnippetForChannel(db, "ch1", "default")).toBe("friendly");
  });

  it("returns null when no profile", () => {
    expect(getSoulSnippetForChannel(db, undefined, undefined)).toBeNull();
  });

  it("returns null when profile has no snippet", () => {
    db.createProfile({ id: "gothic", name: "Gothic" });
    db.setChannelProfile("ch1", "gothic");
    expect(getSoulSnippetForChannel(db, "ch1", undefined)).toBeNull();
  });

  it("prefers channel mapping over default", () => {
    db.createProfile({ id: "gothic", name: "Gothic", soulSnippet: "dark" });
    db.createProfile({ id: "cute", name: "Cute", soulSnippet: "uwu" });
    db.setChannelProfile("ch1", "gothic");
    expect(getSoulSnippetForChannel(db, "ch1", "cute")).toBe("dark");
  });
});

describe("appendPersonaToPrompt", () => {
  it("appends persona for mapped channel", () => {
    db.createProfile({ id: "gothic", name: "Gothic", soulSnippet: "cold" });
    db.setChannelProfile("ch1", "gothic");
    const result = appendPersonaToPrompt("base", db, "ch1", undefined);
    expect(result).toContain("cold");
    expect(result).toContain("--- Hent-ai Character ---");
  });

  it("returns base prompt when no persona", () => {
    const result = appendPersonaToPrompt("base", db, "ch1", undefined);
    expect(result).toBe("base");
  });
});

describe("date mode", () => {
  it("uses chatPrompt for date mode profiles", () => {
    db.createProfile({
      id: "date-girl",
      name: "Date Girl",
      mode: "date",
      soulSnippet: "work persona",
      chatPrompt: "sweet and flirty date persona",
    });
    db.setChannelProfile("ch1", "date-girl");
    expect(getSoulSnippetForChannel(db, "ch1", undefined)).toBe("sweet and flirty date persona");
  });

  it("falls back to soulSnippet if chatPrompt is null in date mode", () => {
    db.createProfile({
      id: "date-fallback",
      name: "Date Fallback",
      mode: "date",
      soulSnippet: "fallback persona",
    });
    db.setChannelProfile("ch1", "date-fallback");
    expect(getSoulSnippetForChannel(db, "ch1", undefined)).toBe("fallback persona");
  });

  it("uses soulSnippet for default mode profiles", () => {
    db.createProfile({
      id: "worker",
      name: "Worker",
      mode: "default",
      soulSnippet: "serious work tone",
      chatPrompt: "this should not be used",
    });
    db.setChannelProfile("ch1", "worker");
    expect(getSoulSnippetForChannel(db, "ch1", undefined)).toBe("serious work tone");
  });

  it("getProfileModeForChannel returns date for date profile", () => {
    db.createProfile({ id: "date-girl", name: "Date", mode: "date" });
    db.setChannelProfile("ch1", "date-girl");
    expect(getProfileModeForChannel(db, "ch1", undefined)).toBe("date");
  });

  it("getProfileModeForChannel returns default when no profile", () => {
    expect(getProfileModeForChannel(db, "ch1", undefined)).toBe("default");
  });
});
