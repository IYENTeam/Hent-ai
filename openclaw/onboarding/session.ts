import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  private persistDir: string | null;

  constructor(timeoutMs = 30 * 60 * 1000, persistDir?: string) {
    this.timeoutMs = timeoutMs;
    this.persistDir = persistDir ?? null;

    if (this.persistDir) {
      this.restoreFromDisk();
    }

    this.sweepTimer = setInterval(() => this.sweep(), timeoutMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.persistDir) {
      for (const [key, session] of this.sessions) {
        this.persistSession(key, session);
      }
    }
  }

  private restoreFromDisk(): void {
    if (!this.persistDir || !existsSync(this.persistDir)) return;
    const now = Date.now();
    for (const file of readdirSync(this.persistDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.persistDir, file), "utf-8");
        const data = JSON.parse(raw) as OnboardingSession;
        if (now - data.lastActivityAt > this.timeoutMs) {
          unlinkSync(join(this.persistDir, file));
          continue;
        }
        data.baseImageBuffer = null;
        data.currentEmotionBuffer = null;
        const key = file.replace(".json", "");
        this.sessions.set(key, data);
      } catch {}
    }
  }

  private persistSession(key: string, session: OnboardingSession): void {
    if (!this.persistDir) return;
    mkdirSync(this.persistDir, { recursive: true });
    const serializable = {
      ...session,
      baseImageBuffer: null,
      currentEmotionBuffer: null,
    };
    writeFileSync(
      join(this.persistDir, `${key}.json`),
      JSON.stringify(serializable, null, 2),
      "utf-8",
    );
  }

  private removePersisted(key: string): void {
    if (!this.persistDir) return;
    try { unlinkSync(join(this.persistDir, `${key}.json`)); } catch {}
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt > this.timeoutMs) {
        this.sessions.delete(key);
        this.removePersisted(key);
      }
    }
  }

  get(channelId: string, userId: string): OnboardingSession | null {
    const key = sessionKey(channelId, userId);
    const session = this.sessions.get(key) ?? null;
    if (session && Date.now() - session.lastActivityAt > this.timeoutMs) {
      this.sessions.delete(key);
      this.removePersisted(key);
      return null;
    }
    return session;
  }

  getByChannel(channelId: string): OnboardingSession | null {
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId) {
        if (Date.now() - session.lastActivityAt > this.timeoutMs) {
          const key = sessionKey(session.channelId, session.userId);
          this.sessions.delete(key);
          this.removePersisted(key);
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
    const key = sessionKey(channelId, userId);
    this.sessions.set(key, session);
    this.persistSession(key, session);
    return session;
  }

  touch(session: OnboardingSession): void {
    session.lastActivityAt = Date.now();
    const key = sessionKey(session.channelId, session.userId);
    this.persistSession(key, session);
  }

  delete(channelId: string, userId: string): void {
    const key = sessionKey(channelId, userId);
    this.sessions.delete(key);
    this.removePersisted(key);
  }
}
