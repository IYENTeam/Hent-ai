import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { SessionManager, OnboardingState, EMOTIONS } from "./session.js";
import { parseIntent, parseImageIntent, isTrigger } from "./parsers.js";

describe("parsers", () => {
  describe("isTrigger", () => {
    it("matches onboarding keywords", () => {
      expect(isTrigger("onboarding")).toBe(true);
      expect(isTrigger("온보딩")).toBe(true);
      expect(isTrigger("셋업")).toBe(true);
      expect(isTrigger("setup")).toBe(true);
      expect(isTrigger("ONBOARDING")).toBe(true);
    });

    it("rejects non-trigger text", () => {
      expect(isTrigger("hello")).toBe(false);
      expect(isTrigger("onboarding now")).toBe(false);
      expect(isTrigger("start onboarding")).toBe(false);
    });
  });

  describe("parseIntent", () => {
    it("detects positive responses", () => {
      expect(parseIntent("좋아").type).toBe("positive");
      expect(parseIntent("ㅇㅇ").type).toBe("positive");
      expect(parseIntent("ok").type).toBe("positive");
      expect(parseIntent("good").type).toBe("positive");
      expect(parseIntent("yes").type).toBe("positive");
      expect(parseIntent("완벽").type).toBe("positive");
    });

    it("detects regenerate requests", () => {
      expect(parseIntent("다시").type).toBe("regenerate");
      expect(parseIntent("재생성").type).toBe("regenerate");
      expect(parseIntent("retry").type).toBe("regenerate");
      expect(parseIntent("again").type).toBe("regenerate");
    });

    it("detects skip", () => {
      expect(parseIntent("스킵").type).toBe("skip");
      expect(parseIntent("skip").type).toBe("skip");
      expect(parseIntent("건너뛰기").type).toBe("skip");
    });

    it("detects cancel", () => {
      expect(parseIntent("취소").type).toBe("cancel");
      expect(parseIntent("cancel").type).toBe("cancel");
      expect(parseIntent("종료").type).toBe("cancel");
    });

    it("returns feedback for unrecognized text", () => {
      const result = parseIntent("좀 더 귀엽게 해줘");
      expect(result.type).toBe("feedback");
      if (result.type === "feedback") {
        expect(result.text).toBe("좀 더 귀엽게 해줘");
      }
    });

    it("cancel takes priority over other patterns", () => {
      expect(parseIntent("취소").type).toBe("cancel");
    });
  });

  describe("parseImageIntent", () => {
    it("detects use-as-base responses", () => {
      expect(parseImageIntent("1").type).toBe("use_as_base");
      expect(parseImageIntent("그대로").type).toBe("use_as_base");
      expect(parseImageIntent("사용").type).toBe("use_as_base");
    });

    it("detects use-as-reference responses", () => {
      expect(parseImageIntent("2").type).toBe("use_as_reference");
      expect(parseImageIntent("참고").type).toBe("use_as_reference");
      expect(parseImageIntent("새로").type).toBe("use_as_reference");
    });

    it("detects cancel", () => {
      expect(parseImageIntent("취소").type).toBe("cancel");
    });

    it("returns feedback for unrecognized text", () => {
      const result = parseImageIntent("something else");
      expect(result.type).toBe("feedback");
    });
  });
});

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(1000);
  });

  afterEach(() => {
    manager.destroy();
  });

  it("creates and retrieves a session", () => {
    const session = manager.create("ch1", "user1");
    expect(session.state).toBe(OnboardingState.AWAITING_CHARACTER);
    expect(session.channelId).toBe("ch1");
    expect(session.userId).toBe("user1");

    const retrieved = manager.get("ch1", "user1");
    expect(retrieved).toBe(session);
  });

  it("returns null for non-existent session", () => {
    expect(manager.get("ch1", "user1")).toBeNull();
  });

  it("deletes a session", () => {
    manager.create("ch1", "user1");
    manager.delete("ch1", "user1");
    expect(manager.get("ch1", "user1")).toBeNull();
  });

  it("getByChannel finds session in channel", () => {
    const session = manager.create("ch1", "user1");
    expect(manager.getByChannel("ch1")).toBe(session);
    expect(manager.getByChannel("ch2")).toBeNull();
  });

  it("expires session after timeout", async () => {
    const shortManager = new SessionManager(50);
    shortManager.create("ch1", "user1");
    await new Promise((r) => setTimeout(r, 60));
    expect(shortManager.get("ch1", "user1")).toBeNull();
    shortManager.destroy();
  });

  it("touch resets activity timestamp", async () => {
    const shortManager = new SessionManager(100);
    const session = shortManager.create("ch1", "user1");
    await new Promise((r) => setTimeout(r, 60));
    shortManager.touch(session);
    await new Promise((r) => setTimeout(r, 60));
    expect(shortManager.get("ch1", "user1")).not.toBeNull();
    shortManager.destroy();
  });

  it("isGenerating returns true for generating states", () => {
    const session = manager.create("ch1", "user1");
    session.state = OnboardingState.GENERATING_BASE;
    expect(manager.isGenerating(session)).toBe(true);
    session.state = OnboardingState.GENERATING_EMOTION;
    expect(manager.isGenerating(session)).toBe(true);
    session.state = OnboardingState.AWAITING_CHARACTER;
    expect(manager.isGenerating(session)).toBe(false);
  });

  it("sweep cleans expired sessions", async () => {
    const shortManager = new SessionManager(50);
    shortManager.create("ch1", "user1");
    shortManager.create("ch2", "user2");
    await new Promise((r) => setTimeout(r, 60));
    expect(shortManager.get("ch1", "user1")).toBeNull();
    expect(shortManager.get("ch2", "user2")).toBeNull();
    shortManager.destroy();
  });
});
