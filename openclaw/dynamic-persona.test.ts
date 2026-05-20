import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileDatabase } from "@hent-ai/shared/db";
import {
  buildDynamicPrompt,
  getSoulSnippetForChannel,
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
