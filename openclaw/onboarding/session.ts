export const EMOTIONS = [
  "happy",
  "neutral",
  "loyalty",
  "sorry",
  "confused",
  "focused",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export enum OnboardingState {
  AWAITING_CHARACTER = "awaiting_character",
  AWAITING_IMAGE_INTENT = "awaiting_image_intent",
  GENERATING_BASE = "generating_base",
  AWAITING_BASE_CONFIRM = "awaiting_base_confirm",
  GENERATING_EMOTION = "generating_emotion",
  AWAITING_EMOTION_CONFIRM = "awaiting_emotion_confirm",
  COMPLETED = "completed",
}

export interface OnboardingSession {
  channelId: string;
  userId: string;
  workspaceDir: string;
  state: OnboardingState;
  character: string;
  baseFeedback: string[];
  baseImageBuffer: Buffer | null;
  referenceImageUrl: string | null;
  currentEmotionIndex: number;
  currentEmotionBuffer: Buffer | null;
  emotionFeedback: Partial<Record<Emotion, string[]>>;
  createdAt: number;
  lastActivityAt: number;
}

function sessionKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

export class SessionManager {
  private sessions = new Map<string, OnboardingSession>();
  private timeoutMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(timeoutMs = 30 * 60 * 1000) {
    this.timeoutMs = timeoutMs;
    this.sweepTimer = setInterval(() => this.sweep(), timeoutMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt > this.timeoutMs) {
        this.sessions.delete(key);
      }
    }
  }

  get(channelId: string, userId: string): OnboardingSession | null {
    const key = sessionKey(channelId, userId);
    const session = this.sessions.get(key) ?? null;
    if (session && Date.now() - session.lastActivityAt > this.timeoutMs) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  getByChannel(channelId: string): OnboardingSession | null {
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId) {
        if (Date.now() - session.lastActivityAt > this.timeoutMs) {
          this.sessions.delete(sessionKey(session.channelId, session.userId));
          return null;
        }
        return session;
      }
    }
    return null;
  }

  create(channelId: string, userId: string, workspaceDir: string): OnboardingSession {
    const now = Date.now();
    const session: OnboardingSession = {
      channelId,
      userId,
      workspaceDir,
      state: OnboardingState.AWAITING_CHARACTER,
      character: "",
      baseFeedback: [],
      baseImageBuffer: null,
      referenceImageUrl: null,
      currentEmotionIndex: 0,
      currentEmotionBuffer: null,
      emotionFeedback: {},
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(sessionKey(channelId, userId), session);
    return session;
  }

  touch(session: OnboardingSession): void {
    session.lastActivityAt = Date.now();
  }

  delete(channelId: string, userId: string): void {
    this.sessions.delete(sessionKey(channelId, userId));
  }
}
