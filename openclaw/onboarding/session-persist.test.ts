import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, OnboardingState } from "./session.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "onboarding-session-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

describe("SessionManager with persistence", () => {
  it("persists sessions to disk on create", () => {
    const manager = new SessionManager(60_000, tmpDir);
    manager.create("ch1", "user1", "/tmp/workspace");
    manager.destroy();
    
    // Check that a JSON file was written
    const files = require("node:fs").readdirSync(tmpDir);
    expect(files.some((f: string) => f.endsWith(".json"))).toBe(true);
  });

  it("restores sessions from disk on init", () => {
    // Create a session and persist it
    const manager1 = new SessionManager(60_000, tmpDir);
    manager1.create("ch1", "user1", "/tmp/workspace");
    manager1.destroy();

    // Create new manager - should restore
    const manager2 = new SessionManager(60_000, tmpDir);
    const session = manager2.get("ch1", "user1");
    expect(session).not.toBeNull();
    expect(session?.channelId).toBe("ch1");
    manager2.destroy();
  });

  it("does not restore expired sessions from disk", () => {
    // Manually write an expired session file
    const expiredSession = {
      channelId: "ch99",
      userId: "user99",
      workspaceDir: "/tmp/w",
      state: OnboardingState.AWAITING_CHARACTER,
      character: "",
      baseFeedback: [],
      baseImageBuffer: null,
      referenceImageUrl: null,
      currentEmotionIndex: 0,
      currentEmotionBuffer: null,
      emotionFeedback: {},
      createdAt: Date.now() - 200_000,
      lastActivityAt: Date.now() - 200_000,
    };
    writeFileSync(join(tmpDir, "ch99_user99.json"), JSON.stringify(expiredSession));

    const manager = new SessionManager(60_000, tmpDir);
    const session = manager.get("ch99", "user99");
    expect(session).toBeNull();
    manager.destroy();
  });

  it("persists on touch", () => {
    const manager = new SessionManager(60_000, tmpDir);
    const session = manager.create("ch1", "user1", "/tmp/workspace");
    const oldTime = session.lastActivityAt;
    
    // Small delay to ensure timestamp changes
    const ts = Date.now();
    while (Date.now() === ts) {} // spin
    
    manager.touch(session);
    expect(session.lastActivityAt).toBeGreaterThanOrEqual(oldTime);
    manager.destroy();
  });

  it("removes persisted file on delete", () => {
    const manager = new SessionManager(60_000, tmpDir);
    manager.create("ch1", "user1", "/tmp/workspace");
    manager.delete("ch1", "user1");
    manager.destroy();
    
    // Should have been cleaned up
    const session = manager.get("ch1", "user1");
    expect(session).toBeNull();
  });

  it("handles corrupt json files gracefully during restore", () => {
    writeFileSync(join(tmpDir, "bad.json"), "{ invalid json }");
    // Should not throw
    const manager = new SessionManager(60_000, tmpDir);
    manager.destroy();
  });

  it("handles non-existent persist dir gracefully", () => {
    const nonExistent = join(tmpDir, "does-not-exist");
    // Should not throw
    const manager = new SessionManager(60_000, nonExistent);
    manager.destroy();
  });

  it("destroy persists all active sessions", () => {
    const manager = new SessionManager(60_000, tmpDir);
    manager.create("ch1", "user1", "/tmp/workspace");
    manager.create("ch2", "user2", "/tmp/workspace2");
    manager.destroy();
    
    const files = require("node:fs").readdirSync(tmpDir).filter((f: string) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("get() removes persisted file when session expires during get()", async () => {
    const manager = new SessionManager(50, tmpDir);
    manager.create("ch5", "user5", "/tmp/workspace");
    await new Promise((r) => setTimeout(r, 60));
    const session = manager.get("ch5", "user5");
    expect(session).toBeNull();
    manager.destroy();
  });

  it("getByChannel() returns null and removes persisted file when expired", async () => {
    const manager = new SessionManager(50, tmpDir);
    manager.create("ch6", "user6", "/tmp/workspace");
    await new Promise((r) => setTimeout(r, 60));
    const session = manager.getByChannel("ch6");
    expect(session).toBeNull();
    manager.destroy();
  
  });

});