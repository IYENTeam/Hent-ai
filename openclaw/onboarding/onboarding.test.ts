import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerOnboarding } from "./index.js";
import { getOnboardingSkill, ONBOARDING_EXIT_HINT, ONBOARDING_SKILLS } from "./flow.js";
import { isTrigger, parseImageIntent, parseIntent } from "./parsers.js";
import { OnboardingState, SessionManager } from "./session.js";

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
      expect(isTrigger("start onboarding")).toBe(true);
      expect(isTrigger("just mentioning onboarding in passing")).toBe(false);
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

describe("onboarding skills", () => {
  it("registers one skill for each active onboarding state", () => {
    const states = [
      OnboardingState.AWAITING_CHARACTER,
      OnboardingState.AWAITING_IMAGE_INTENT,
      OnboardingState.AWAITING_BASE_CONFIRM,
      OnboardingState.AWAITING_EMOTION_CONFIRM,
      OnboardingState.GENERATING_BASE,
      OnboardingState.GENERATING_EMOTION,
    ];

    for (const state of states) {
      expect(getOnboardingSkill(state)?.id).toBeTruthy();
    }
  });

  it("marks generation skills as busy handlers", () => {
    expect(getOnboardingSkill(OnboardingState.GENERATING_BASE)?.busy).toBe(true);
    expect(getOnboardingSkill(OnboardingState.GENERATING_EMOTION)?.busy).toBe(true);
    expect(getOnboardingSkill(OnboardingState.AWAITING_CHARACTER)?.busy).toBeFalsy();
  });

  it("does not use duplicate skill ids", () => {
    const ids = ONBOARDING_SKILLS.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("onboarding runtime", () => {
  it("exposes the accepted exit commands in the shared hint", () => {
    expect(ONBOARDING_EXIT_HINT).toContain("취소");
    expect(ONBOARDING_EXIT_HINT).toContain("cancel");
    expect(ONBOARDING_EXIT_HINT).toContain("종료");
    expect(ONBOARDING_EXIT_HINT).toContain("그만");
  });

  it("identifies trigger and active-session messages for normal-hook suppression", async () => {
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
    const runtime = registerOnboarding(
      {
        on: (_event, handler) => handlers.push(handler),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      "token",
      "/tmp/hent-ai-test-assets",
      {},
    );

    expect(runtime?.isOnboardingMessage("123", "user1", "onboarding")).toBe(true);
    expect(runtime?.isOnboardingMessage("123", "user1", "hello")).toBe(false);
    expect(runtime?.hasActiveSession("123")).toBe(false);

    await handlers[0]?.({
      content: "onboarding",
      metadata: { to: "channel:123", from: "user1", messageId: "msg1" },
    }, {});

    expect(runtime?.isOnboardingMessage("123", "user1", "cute cat")).toBe(true);
    expect(runtime?.isOnboardingMessage("123", "user2", "cute cat")).toBe(false);
    expect(runtime?.hasActiveSession("123")).toBe(true);
    expect(runtime?.hasActiveSession("456")).toBe(false);
  });

  it("returns null when onboarding is disabled", () => {
    const runtime = registerOnboarding(
      {
        on: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      "token",
      "/tmp/hent-ai-test-assets",
      { enabled: false },
    );

    expect(runtime).toBeNull();
  });
});
