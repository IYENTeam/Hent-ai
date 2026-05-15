import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager, OnboardingState, EMOTIONS } from "./session.js";
import { parseIntent } from "./parsers.js";
import { handleMessage, ONBOARDING_EXIT_HINT, type FlowConfig } from "./flow.js";
import { sendTextMessage, type Logger } from "./discord-utils.js";

/**
 * Check if emotion images already exist in the image directory.
 * Returns the list of existing emotion filenames.
 */
function detectExistingAssets(imageDir: string): string[] {
  return EMOTIONS.filter((e) => {
    const filePath = resolve(imageDir, `${e}.png`);
    return existsSync(filePath);
  });
}

export interface OnboardingConfig {
  enabled?: boolean;
  trigger?: string;
  model?: string;
  size?: string;
  sessionTimeoutMs?: number;
  allowedUsers?: string[];
}

export type IntentDetector = (text: string) => Promise<boolean>;

export interface OnboardingRuntime {
  isOnboardingMessage: (channelId: string, userId: string, content: string) => boolean;
}

export interface PluginApi {
  on: (
    event: string,
    handler: (event: unknown, ctx: unknown) => Promise<void>,
    options?: { name?: string },
  ) => void;
  logger: Logger;
}

export function registerOnboarding(
  api: PluginApi,
  botToken: string,
  imageDir: string,
  onboardingConfig: OnboardingConfig,
  detectIntent?: IntentDetector,
): OnboardingRuntime | null {
  if (onboardingConfig.enabled === false) return null;

  const sessions = new SessionManager(onboardingConfig.sessionTimeoutMs);
  const logger = api.logger;

  const flowConfig: FlowConfig = {
    token: botToken,
    imageDir,
    model: onboardingConfig.model,
    size: onboardingConfig.size,
    logger,
  };

  // Inline trigger detection to avoid jiti cache staleness.
  // jiti hashes only the entry file (index.ts), not transitive deps like parsers.ts.
  // When parsers.ts changes but index.ts doesn't, the old compiled code is served.
  const TRIGGER_KEYWORDS = /봇|캐릭터|이미지|셋업|setup|onboarding|온보딩|생성|만들|바꾸/i;
  const TRIGGER_ACTIONS = /하고|하자|해줘|해줄|시작|할래|하고파|할까|start|begin|want|원해|해봐|해보|만들|새로|다시|바꾸/i;
  const TRIGGER_EXACT = /^(onboarding|온보딩|셋업|setup)[\s!.]*$/i;

  function isOnboardingTrigger(text: string): boolean {
    const trimmed = text.trim();
    if (TRIGGER_EXACT.test(trimmed)) return true;
    return TRIGGER_KEYWORDS.test(trimmed) && TRIGGER_ACTIONS.test(trimmed);
  }

  const runtime: OnboardingRuntime = {
    isOnboardingMessage: (channelId, userId, content) => {
      const trimmed = content.trim();
      if (isOnboardingTrigger(trimmed)) return true;
      return sessions.get(channelId, userId) !== null;
    },
  };

  api.on(
    "message_received",
    async (event) => {
      const { content, metadata } = event as {
        content?: string;
        metadata?: Record<string, unknown>;
      };

      if (!content) return;

      const rawTo = metadata?.to as string | undefined;
      if (!rawTo) return;
      const channelId = rawTo.startsWith("channel:") ? rawTo.slice(8) : rawTo;
      if (!channelId || !/^\d+$/.test(channelId)) return;

      const userId = (metadata?.from as string) ?? "unknown";
      const messageId = metadata?.messageId as string | undefined;
      const trimmed = content.trim();

      if (isOnboardingTrigger(trimmed)) {
        logger.info(`onboarding: trigger detected from user=${userId} text="${trimmed.slice(0, 50)}"`);
        const existing = sessions.getByChannel(channelId);
        if (existing && existing.userId !== userId) {
          await sendTextMessage(
            botToken,
            channelId,
            `현재 다른 사용자가 온보딩 중입니다.`,
            logger,
          );
          return;
        }

        if (existing && existing.userId === userId) {
          await sendTextMessage(
            botToken,
            channelId,
            "이미 온보딩이 진행중입니다. \"취소\"를 입력하면 처음부터 다시 시작할 수 있어요.",
            logger,
          );
          return;
        }

        if (
          onboardingConfig.allowedUsers &&
          onboardingConfig.allowedUsers.length > 0 &&
          !onboardingConfig.allowedUsers.includes(userId)
        ) {
          await sendTextMessage(
            botToken,
            channelId,
            "온보딩 권한이 없습니다.",
            logger,
          );
          return;
        }

        // Check for existing assets (returning user detection)
        const existingAssets = detectExistingAssets(imageDir);
        const isReturningUser = existingAssets.length >= EMOTIONS.length;

        sessions.create(channelId, userId);

        if (isReturningUser) {
          // Returning user — offer upgrade path instead of full onboard
          await sendTextMessage(
            botToken,
            channelId,
            "🎨 Hent-ai 온보딩 — 이미 세팅되어 있어요!\n\n" +
              `현재 ${existingAssets.length}개 감정 이미지가 설치되어 있습니다: ${existingAssets.join(", ")}\n\n` +
              "선택해주세요:\n" +
              '1\ufe0f\u20e3 "처음부터" — 새 캐릭터로 전체 다시 생성\n' +
              '2\ufe0f\u20e3 "업데이트" — 특정 감정만 다시 생성\n' +
              '3\ufe0f\u20e3 "취소" — 온보딩 종료\n\n' +
              ONBOARDING_EXIT_HINT,
            logger,
          );
          return;
        }

        await sendTextMessage(
          botToken,
          channelId,
          "🎨 Hent-ai 온보딩을 시작합니다!\n\n" +
            "지금부터 이 채널의 내 온보딩 메시지는 온보딩 모드에서만 처리돼요.\n" +
            "일반 자동 thinking/cheer 이미지는 잠시 멈추고, 다른 사용자나 다른 채널은 평소처럼 동작합니다.\n\n" +
            "캐릭터를 설명해주세요.\n" +
            "예: \"cute orange cat\", \"pixel art robot\", \"anime girl with blue hair\"\n\n" +
            "이미지를 첨부하면:\n" +
            "• 이미지만 → 그대로 base 캐릭터로 사용할지 물어봅니다\n" +
            "• 이미지 + 텍스트 → 이미지를 참고하여 생성할지 물어봅니다\n\n" +
            ONBOARDING_EXIT_HINT,
          logger,
        );
        return;
      }

      const session = sessions.get(channelId, userId);
      if (!session) return;
      if (session.state === OnboardingState.COMPLETED) return;

      await handleMessage(session, sessions, trimmed, channelId, messageId, flowConfig);
    },
    { name: "emotion-image-onboarding" },
  );

  logger.info("onboarding: registered onboarding handler");
  return runtime;
}
