import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMessage, getOnboardingSkill, ONBOARDING_SKILLS, ONBOARDING_EXIT_HINT } from "./flow.js";
import { OnboardingState, type OnboardingSession, type SessionManager } from "./session.js";

vi.mock("./discord-utils.js", () => ({
  sendTextMessage: vi.fn().mockResolvedValue("msg1"),
  editTextMessage: vi.fn().mockResolvedValue(undefined),
  sendImageBufferMessage: vi.fn().mockResolvedValue("msg2"),
  getMessageAttachments: vi.fn().mockResolvedValue([]),
  downloadUrl: vi.fn().mockResolvedValue(null),
}));

vi.mock("@hent-ai/generate", () => ({
  generateImage: vi.fn().mockResolvedValue(Buffer.from("FAKE_PNG")),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeSession(overrides: Partial<OnboardingSession> = {}): OnboardingSession {
  return {
    channelId: "ch1",
    userId: "user1",
    workspaceDir: "/tmp/workspace",
    state: OnboardingState.AWAITING_CHARACTER,
    character: "",
    baseFeedback: [],
    baseImageBuffer: null,
    referenceImageUrl: null,
    currentEmotionIndex: 0,
    currentEmotionBuffer: null,
    emotionFeedback: {},
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

const mockSessions: SessionManager = {
  get: vi.fn().mockReturnValue(null),
  getByChannel: vi.fn().mockReturnValue(null),
  create: vi.fn(),
  delete: vi.fn(),
  touch: vi.fn(),
  destroy: vi.fn(),
} as unknown as SessionManager;

const makeConfig = () => ({
  token: "bot-token",
  imageDir: "/tmp/images",
  logger: mockLogger,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleMessage", () => {
  it("warns when no skill registered for state", async () => {
    const session = makeSession({ state: OnboardingState.COMPLETED });
    await handleMessage(session, mockSessions, "hello", "ch1", undefined, makeConfig());
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("no skill"));
  });

  it("calls skill handler for known state", async () => {
    const session = makeSession({ state: OnboardingState.AWAITING_CHARACTER, character: "" });
    await handleMessage(session, mockSessions, "cancel", "ch1", undefined, makeConfig());
    // cancel should trigger cancelOnboarding -> delete + sendTextMessage
    const { sendTextMessage } = await import("./discord-utils.js");
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalled();
  });
});

describe("AWAITING_CHARACTER state", () => {
  it("cancels on cancel intent", async () => {
    const session = makeSession();
    await handleMessage(session, mockSessions, "취소", "ch1", undefined, makeConfig());
    expect(vi.mocked(mockSessions.delete)).toHaveBeenCalled();
  });

  it("prompts for description when no text and no attachment", async () => {
    const session = makeSession();
    await handleMessage(session, mockSessions, "", "ch1", undefined, makeConfig());
    const { sendTextMessage } = await import("./discord-utils.js");
    const calls = vi.mocked(sendTextMessage).mock.calls;
    const prompted = calls.some(([,,text]) => typeof text === "string" && text.includes("캐릭터를 설명해주세요"));
    expect(prompted).toBe(true);
  });

  it("sets character and starts base generation on text feedback", async () => {
    const session = makeSession();
    await handleMessage(session, mockSessions, "cute orange cat", "ch1", undefined, makeConfig());
    // Should advance to GENERATING_BASE or AWAITING_BASE_CONFIRM
    expect(session.character).toBe("cute orange cat");
  });

  it("handles attachment in message", async () => {
    const { getMessageAttachments, downloadUrl } = await import("./discord-utils.js");
    vi.mocked(getMessageAttachments).mockResolvedValueOnce([
      { id: "a1", url: "https://cdn.example.com/img.png", filename: "img.png", content_type: "image/png", size: 100 }
    ]);
    vi.mocked(downloadUrl).mockResolvedValueOnce(Buffer.from("PNG_DATA"));
    
    const session = makeSession();
    await handleMessage(session, mockSessions, "", "ch1", "msg1", makeConfig());
    
    expect(session.state).toBe(OnboardingState.AWAITING_IMAGE_INTENT);
  });
});

describe("AWAITING_IMAGE_INTENT state", () => {
  it("cancels on cancel intent", async () => {
    const session = makeSession({ state: OnboardingState.AWAITING_IMAGE_INTENT });
    await handleMessage(session, mockSessions, "취소", "ch1", undefined, makeConfig());
    expect(vi.mocked(mockSessions.delete)).toHaveBeenCalled();
  });

  it("uses image as base when referenceImageUrl is set", async () => {
    const b64 = Buffer.from("PNG_DATA").toString("base64");
    const session = makeSession({
      state: OnboardingState.AWAITING_IMAGE_INTENT,
      referenceImageUrl: `data:image/png;base64,${b64}`,
    });
    await handleMessage(session, mockSessions, "1", "ch1", undefined, makeConfig());
    expect(session.baseImageBuffer).not.toBeNull();
    expect(session.state).toBe(OnboardingState.AWAITING_BASE_CONFIRM);
  });

  it("prompts for character if use_as_reference but no character", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_IMAGE_INTENT,
      character: "",
    });
    await handleMessage(session, mockSessions, "2", "ch1", undefined, makeConfig());
    expect(session.state).toBe(OnboardingState.AWAITING_CHARACTER);
  });

  it("starts base generation when use_as_reference with character", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_IMAGE_INTENT,
      character: "cute cat",
    });
    await handleMessage(session, mockSessions, "2", "ch1", undefined, makeConfig());
    // Should have started generation
    const { sendTextMessage } = await import("./discord-utils.js");
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalled();
  });

  it("shows selection prompt for unrecognized text", async () => {
    const session = makeSession({ state: OnboardingState.AWAITING_IMAGE_INTENT });
    await handleMessage(session, mockSessions, "random text", "ch1", undefined, makeConfig());
    const { sendTextMessage } = await import("./discord-utils.js");
    const calls = vi.mocked(sendTextMessage).mock.calls;
    const prompted = calls.some(([,,text]) => typeof text === "string" && text.includes("1️⃣"));
    expect(prompted).toBe(true);
  });

  it("returns null message when use_as_base but no referenceImageUrl", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_IMAGE_INTENT,
      referenceImageUrl: null,
    });
    await handleMessage(session, mockSessions, "1", "ch1", undefined, makeConfig());
    expect(vi.mocked(mockSessions.delete)).toHaveBeenCalled();
  });
});

describe("AWAITING_BASE_CONFIRM state", () => {
  it("cancels on cancel", async () => {
    const session = makeSession({ state: OnboardingState.AWAITING_BASE_CONFIRM });
    await handleMessage(session, mockSessions, "취소", "ch1", undefined, makeConfig());
    expect(vi.mocked(mockSessions.delete)).toHaveBeenCalled();
  });

  it("advances to emotion generation on positive response", async () => {
    const session = makeSession({ state: OnboardingState.AWAITING_BASE_CONFIRM });
    await handleMessage(session, mockSessions, "좋아", "ch1", undefined, makeConfig());
    // Should start emotion generation
    const { sendTextMessage } = await import("./discord-utils.js");
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalled();
  });

  it("regenerates on regenerate intent", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_BASE_CONFIRM,
      character: "test character",
    });
    await handleMessage(session, mockSessions, "다시", "ch1", undefined, makeConfig());
    const { sendTextMessage } = await import("./discord-utils.js");
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalled();
  });

  it("adds feedback and regenerates on feedback intent", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_BASE_CONFIRM,
      character: "test character",
    });
    await handleMessage(session, mockSessions, "make it cuter", "ch1", undefined, makeConfig());
    expect(session.baseFeedback).toContain("make it cuter");
  });

  it("handles skip same as positive", async () => {
    const session = makeSession({ state: OnboardingState.AWAITING_BASE_CONFIRM });
    await handleMessage(session, mockSessions, "스킵", "ch1", undefined, makeConfig());
    // Should start emotion generation
    const { sendTextMessage } = await import("./discord-utils.js");
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalled();
  });
});

describe("AWAITING_EMOTION_CONFIRM state", () => {
  it("cancels on cancel", async () => {
    const session = makeSession({ state: OnboardingState.AWAITING_EMOTION_CONFIRM });
    await handleMessage(session, mockSessions, "취소", "ch1", undefined, makeConfig());
    expect(vi.mocked(mockSessions.delete)).toHaveBeenCalled();
  });

  it("saves emotion and advances on positive", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_EMOTION_CONFIRM,
      currentEmotionIndex: 0,
      currentEmotionBuffer: Buffer.from("PNG"),
    });
    await handleMessage(session, mockSessions, "좋아", "ch1", undefined, makeConfig());
    // After saving, index advances and next emotion generation runs (setting new buffer)
    expect(session.currentEmotionIndex).toBe(1);
    // State should be GENERATING_EMOTION or AWAITING_EMOTION_CONFIRM after next gen
    expect([OnboardingState.GENERATING_EMOTION, OnboardingState.AWAITING_EMOTION_CONFIRM])
      .toContain(session.state);
  });

  it("completes onboarding after all emotions confirmed", async () => {
    const LAST_EMOTION_INDEX = 5; // 6 emotions total, 0-indexed
    const session = makeSession({
      state: OnboardingState.AWAITING_EMOTION_CONFIRM,
      currentEmotionIndex: LAST_EMOTION_INDEX,
      currentEmotionBuffer: Buffer.from("PNG"),
    });
    await handleMessage(session, mockSessions, "좋아", "ch1", undefined, makeConfig());
    // Should trigger completeOnboarding -> sessions.delete
    expect(vi.mocked(mockSessions.delete)).toHaveBeenCalled();
  });

  it("regenerates on regenerate intent", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_EMOTION_CONFIRM,
      character: "test",
    });
    await handleMessage(session, mockSessions, "다시", "ch1", undefined, makeConfig());
    const { sendTextMessage } = await import("./discord-utils.js");
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalled();
  });

  it("adds emotion feedback and regenerates", async () => {
    const session = makeSession({
      state: OnboardingState.AWAITING_EMOTION_CONFIRM,
      character: "test",
    });
    await handleMessage(session, mockSessions, "more expressive", "ch1", undefined, makeConfig());
    const emotion = "happy"; // first emotion
    expect(session.emotionFeedback[emotion]).toContain("more expressive");
  });

  it("replaces emotion with attachment if present", async () => {
    const { getMessageAttachments, downloadUrl } = await import("./discord-utils.js");
    vi.mocked(getMessageAttachments).mockResolvedValueOnce([
      { id: "a1", url: "https://cdn.example.com/img.png", filename: "img.png", content_type: "image/png", size: 100 }
    ]);
    vi.mocked(downloadUrl).mockResolvedValueOnce(Buffer.from("REPLACEMENT_PNG"));

    const session = makeSession({ state: OnboardingState.AWAITING_EMOTION_CONFIRM });
    await handleMessage(session, mockSessions, "좋아", "ch1", "msg1", makeConfig());
    
    // Should have sent replacement image
    const { sendImageBufferMessage } = await import("./discord-utils.js");
    expect(vi.mocked(sendImageBufferMessage)).toHaveBeenCalled();
  });
});

describe("generation error handling", () => {
  it("handles base generation error gracefully", async () => {
    const { generateImage } = await import("@hent-ai/generate");
    vi.mocked(generateImage).mockRejectedValueOnce(new Error("API error"));
    
    const session = makeSession({
      state: OnboardingState.AWAITING_BASE_CONFIRM,
      character: "test",
    });
    await handleMessage(session, mockSessions, "다시", "ch1", undefined, makeConfig());
    
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("base generation failed"));
  });

  it("handles emotion generation error gracefully", async () => {
    const { generateImage } = await import("@hent-ai/generate");
    vi.mocked(generateImage).mockRejectedValueOnce(new Error("API error"));
    
    const session = makeSession({ state: OnboardingState.AWAITING_BASE_CONFIRM });
    await handleMessage(session, mockSessions, "좋아", "ch1", undefined, makeConfig());
    
    // emotion generation is triggered, might fail
    // Verify no uncaught exception
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe("GENERATING_BASE and GENERATING_EMOTION busy states", () => {
  it("sends wait message for GENERATING_BASE", async () => {
    const session = makeSession({ state: OnboardingState.GENERATING_BASE });
    await handleMessage(session, mockSessions, "hello", "ch1", undefined, makeConfig());
    const { sendTextMessage } = await import("./discord-utils.js");
    const calls = vi.mocked(sendTextMessage).mock.calls;
    const sentBusy = calls.some(([,,t]) => typeof t === "string" && t.includes("생성중"));
    expect(sentBusy).toBe(true);
  });

  it("sends wait message for GENERATING_EMOTION", async () => {
    const session = makeSession({ state: OnboardingState.GENERATING_EMOTION });
    await handleMessage(session, mockSessions, "hello", "ch1", undefined, makeConfig());
    const { sendTextMessage } = await import("./discord-utils.js");
    const calls = vi.mocked(sendTextMessage).mock.calls;
    const sentBusy = calls.some(([,,t]) => typeof t === "string" && t.includes("생성중"));
    expect(sentBusy).toBe(true);
  });
});


describe("completeOnboarding with baseImageBuffer", () => {
  it("writes base.png when baseImageBuffer is set", async () => {
    const { writeFile } = await import("node:fs/promises");
    const LAST_INDEX = 5;
    const session = makeSession({
      state: OnboardingState.AWAITING_EMOTION_CONFIRM,
      currentEmotionIndex: LAST_INDEX,
      currentEmotionBuffer: Buffer.from("PNG"),
      baseImageBuffer: Buffer.from("BASE_PNG"),
    });
    await handleMessage(session, mockSessions, "좋아", "ch1", undefined, makeConfig());
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining("base.png"),
      expect.any(Buffer),
    );
  });
});

describe("removeWorkspace error handling", () => {
  it("warns when rm fails in cancelOnboarding", async () => {
    const { rm } = await import("node:fs/promises");
    vi.mocked(rm).mockRejectedValueOnce(new Error("rm failed"));
    
    const session = makeSession();
    await handleMessage(session, mockSessions, "취소", "ch1", undefined, makeConfig());
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to remove workspace"));
  });
});
