import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type OnboardingSession,
  OnboardingState,
  EMOTIONS,
  SessionManager,
} from "./session.js";
import { parseIntent, parseImageIntent, type UserIntent } from "./parsers.js";
import { buildBasePrompt, buildEmotionPrompt } from "./prompts.js";
import {
  sendTextMessage,
  sendImageBufferMessage,
  editTextMessage,
  getMessageAttachments,
  downloadUrl,
  type Logger,
} from "./discord-utils.js";
import { generateImage, type GenerateOptions } from "../../generate/src/index.js";

export interface FlowConfig {
  token: string;
  imageDir: string;
  model?: string;
  size?: string;
  logger: Logger;
}

function bufferToDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export async function handleMessage(
  session: OnboardingSession,
  sessions: SessionManager,
  content: string,
  channelId: string,
  messageId: string | undefined,
  config: FlowConfig,
): Promise<void> {
  const { token, logger } = config;

  sessions.touch(session);

  if (sessions.isGenerating(session)) {
    await sendTextMessage(token, channelId, "⏳ 생성중입니다. 잠시만요...", logger);
    return;
  }

  switch (session.state) {
    case OnboardingState.AWAITING_CHARACTER:
      await handleAwaitingCharacter(session, sessions, content, channelId, messageId, config);
      break;
    case OnboardingState.AWAITING_IMAGE_INTENT:
      await handleAwaitingImageIntent(session, sessions, content, channelId, config);
      break;
    case OnboardingState.AWAITING_BASE_CONFIRM:
      await handleAwaitingBaseConfirm(session, sessions, content, channelId, config);
      break;
    case OnboardingState.AWAITING_EMOTION_CONFIRM:
      await handleAwaitingEmotionConfirm(session, sessions, content, channelId, config);
      break;
    default:
      break;
  }
}

async function handleAwaitingCharacter(
  session: OnboardingSession,
  sessions: SessionManager,
  content: string,
  channelId: string,
  messageId: string | undefined,
  config: FlowConfig,
): Promise<void> {
  const { token, logger } = config;
  const intent = parseIntent(content);

  if (intent.type === "cancel") {
    sessions.delete(session.channelId, session.userId);
    await sendTextMessage(token, channelId, "온보딩을 취소했습니다.", logger);
    return;
  }

  const hasAttachment = await checkForAttachment(session, channelId, messageId, config);
  const hasText = content.trim().length > 0 && intent.type === "feedback";

  if (hasText) {
    session.character = (intent as { text: string }).text;
  }

  if (hasAttachment) {
    session.state = OnboardingState.AWAITING_IMAGE_INTENT;
    await sendTextMessage(
      token,
      channelId,
      "이미지를 받았어요! 어떻게 사용할까요?\n\n" +
        "1️⃣ 이 이미지를 그대로 base 캐릭터로 사용\n" +
        "2️⃣ 이 이미지를 참고해서 새로 생성",
      logger,
    );
    return;
  }

  if (!hasText) {
    await sendTextMessage(
      token,
      channelId,
      "캐릭터를 설명해주세요. (예: \"cute orange cat\")",
      logger,
    );
    return;
  }

  await startBaseGeneration(session, sessions, channelId, config);
}

async function handleAwaitingImageIntent(
  session: OnboardingSession,
  sessions: SessionManager,
  content: string,
  channelId: string,
  config: FlowConfig,
): Promise<void> {
  const { token, logger } = config;
  const intent = parseImageIntent(content);

  if (intent.type === "cancel") {
    sessions.delete(session.channelId, session.userId);
    await sendTextMessage(token, channelId, "온보딩을 취소했습니다.", logger);
    return;
  }

  if (intent.type === "use_as_base") {
    if (!session.referenceImageUrl) {
      await sendTextMessage(token, channelId, "이미지를 찾을 수 없습니다. 다시 시작해주세요.", logger);
      sessions.delete(session.channelId, session.userId);
      return;
    }
    const dataUrl = session.referenceImageUrl;
    const base64 = dataUrl.split(",")[1];
    session.baseImageBuffer = Buffer.from(base64, "base64");
    session.state = OnboardingState.AWAITING_BASE_CONFIRM;
    await sendImageBufferMessage(
      token,
      channelId,
      session.baseImageBuffer,
      "base.png",
      "이 이미지를 base 캐릭터로 사용합니다.\n마음에 드나요?\n\n• \"좋아\" → 감정 이미지 생성으로 진행\n• \"다시\" → 새로 설명해서 생성\n• 그 외 → 피드백 반영하여 생성",
      logger,
    );
    return;
  }

  if (intent.type === "use_as_reference") {
    if (!session.character) {
      await sendTextMessage(
        token,
        channelId,
        "캐릭터 설명이 필요합니다. 어떤 캐릭터를 만들까요?",
        logger,
      );
      session.state = OnboardingState.AWAITING_CHARACTER;
      return;
    }
    await startBaseGeneration(session, sessions, channelId, config);
    return;
  }

  await sendTextMessage(
    token,
    channelId,
    "1️⃣ 또는 2️⃣를 선택해주세요.\n1 = 그대로 사용 / 2 = 참고해서 새로 생성",
    logger,
  );
}

async function handleAwaitingBaseConfirm(
  session: OnboardingSession,
  sessions: SessionManager,
  content: string,
  channelId: string,
  config: FlowConfig,
): Promise<void> {
  const { token, logger } = config;
  const intent = parseIntent(content);

  if (intent.type === "cancel") {
    sessions.delete(session.channelId, session.userId);
    await sendTextMessage(token, channelId, "온보딩을 취소했습니다.", logger);
    return;
  }

  if (intent.type === "positive" || intent.type === "skip") {
    session.currentEmotionIndex = 0;
    await startEmotionGeneration(session, sessions, channelId, config);
    return;
  }

  if (intent.type === "regenerate") {
    await startBaseGeneration(session, sessions, channelId, config);
    return;
  }

  if (intent.type === "feedback") {
    session.baseFeedback.push(intent.text);
    await startBaseGeneration(session, sessions, channelId, config);
    return;
  }
}

async function handleAwaitingEmotionConfirm(
  session: OnboardingSession,
  sessions: SessionManager,
  content: string,
  channelId: string,
  config: FlowConfig,
): Promise<void> {
  const { token, logger, imageDir } = config;
  const intent = parseIntent(content);
  const emotion = EMOTIONS[session.currentEmotionIndex];

  if (intent.type === "cancel") {
    sessions.delete(session.channelId, session.userId);
    await sendTextMessage(token, channelId, "온보딩을 취소했습니다.", logger);
    return;
  }

  if (intent.type === "positive" || intent.type === "skip") {
    if (session.currentEmotionBuffer) {
      await mkdir(imageDir, { recursive: true });
      await writeFile(resolve(imageDir, `${emotion}.png`), session.currentEmotionBuffer);
    }
    session.currentEmotionBuffer = null;
    session.currentEmotionIndex++;

    if (session.currentEmotionIndex >= EMOTIONS.length) {
      await completeOnboarding(session, sessions, channelId, config);
      return;
    }

    await startEmotionGeneration(session, sessions, channelId, config);
    return;
  }

  if (intent.type === "regenerate") {
    await startEmotionGeneration(session, sessions, channelId, config);
    return;
  }

  if (intent.type === "feedback") {
    if (!session.emotionFeedback[emotion]) {
      session.emotionFeedback[emotion] = [];
    }
    session.emotionFeedback[emotion]!.push(intent.text);
    await startEmotionGeneration(session, sessions, channelId, config);
    return;
  }
}

async function startBaseGeneration(
  session: OnboardingSession,
  sessions: SessionManager,
  channelId: string,
  config: FlowConfig,
): Promise<void> {
  const { token, logger, model, size } = config;

  session.state = OnboardingState.GENERATING_BASE;
  const progressMsgId = await sendTextMessage(
    token,
    channelId,
    "⏳ base 캐릭터를 생성하고 있어요...",
    logger,
  );

  try {
    const prompt = buildBasePrompt(session.character, session.baseFeedback);
    const options: GenerateOptions = {
      prompt,
      model,
      size: size ?? "1024x1024",
      referenceImages: session.referenceImageUrl ? [session.referenceImageUrl] : undefined,
    };

    const buffer = await generateImage(options);
    session.baseImageBuffer = buffer;
    session.state = OnboardingState.AWAITING_BASE_CONFIRM;

    if (progressMsgId) {
      await editTextMessage(token, channelId, progressMsgId, "✅ base 캐릭터 생성 완료!", logger);
    }

    await sendImageBufferMessage(
      token,
      channelId,
      buffer,
      "base.png",
      "이 캐릭터가 마음에 드나요?\n\n• \"좋아\" → 감정 이미지 생성으로 진행\n• \"다시\" → 같은 설정으로 재생성\n• 그 외 텍스트 → 피드백 반영하여 재생성",
      logger,
    );
  } catch (err) {
    session.state = OnboardingState.AWAITING_BASE_CONFIRM;
    const errMsg = err instanceof Error ? err.message : String(err);
    await sendTextMessage(
      token,
      channelId,
      `❌ 생성 실패: ${errMsg}\n\n"다시"를 입력하면 재시도합니다.`,
      logger,
    );
    logger.error(`onboarding: base generation failed: ${err}`);
  }
}

async function startEmotionGeneration(
  session: OnboardingSession,
  sessions: SessionManager,
  channelId: string,
  config: FlowConfig,
): Promise<void> {
  const { token, logger, model, size } = config;
  const emotion = EMOTIONS[session.currentEmotionIndex];

  session.state = OnboardingState.GENERATING_EMOTION;
  const progressMsgId = await sendTextMessage(
    token,
    channelId,
    `⏳ ${emotion} 생성중... [${session.currentEmotionIndex + 1}/${EMOTIONS.length}]`,
    logger,
  );

  try {
    const feedback = session.emotionFeedback[emotion] ?? [];
    const prompt = buildEmotionPrompt(session.character, emotion, feedback);
    const options: GenerateOptions = {
      prompt,
      model,
      size: size ?? "1024x1024",
      referenceImages: session.baseImageBuffer ? [bufferToDataUrl(session.baseImageBuffer)] : undefined,
    };

    const buffer = await generateImage(options);
    session.currentEmotionBuffer = buffer;
    session.state = OnboardingState.AWAITING_EMOTION_CONFIRM;

    if (progressMsgId) {
      await editTextMessage(token, channelId, progressMsgId, `✅ ${emotion} 생성 완료!`, logger);
    }

    await sendImageBufferMessage(
      token,
      channelId,
      buffer,
      `${emotion}.png`,
      `**${emotion}** [${session.currentEmotionIndex + 1}/${EMOTIONS.length}]\n마음에 드나요?\n\n• \"좋아\" → 저장하고 다음으로\n• \"스킵\" → 현재 결과 저장, 다음으로\n• 그 외 텍스트 → 피드백 반영하여 재생성`,
      logger,
    );
  } catch (err) {
    session.state = OnboardingState.AWAITING_EMOTION_CONFIRM;
    const errMsg = err instanceof Error ? err.message : String(err);
    await sendTextMessage(
      token,
      channelId,
      `❌ ${emotion} 생성 실패: ${errMsg}\n\n"다시"를 입력하면 재시도합니다.`,
      logger,
    );
    logger.error(`onboarding: emotion generation failed for ${emotion}: ${err}`);
  }
}

async function completeOnboarding(
  session: OnboardingSession,
  sessions: SessionManager,
  channelId: string,
  config: FlowConfig,
): Promise<void> {
  const { token, logger, imageDir } = config;

  if (session.baseImageBuffer) {
    await mkdir(imageDir, { recursive: true });
    await writeFile(resolve(imageDir, "base.png"), session.baseImageBuffer);
  }

  const emotionList = EMOTIONS.map((e) => `${e}.png`).join(", ");
  await sendTextMessage(
    token,
    channelId,
    `✅ 온보딩 완료!\n\n저장된 이미지:\n  base.png, ${emotionList}\n  → ${imageDir}\n\n이제부터 봇 응답에 감정 이미지가 자동으로 붙습니다. 🎉`,
    logger,
  );

  sessions.delete(session.channelId, session.userId);
}

async function checkForAttachment(
  session: OnboardingSession,
  channelId: string,
  messageId: string | undefined,
  config: FlowConfig,
): Promise<boolean> {
  if (!messageId) return false;

  const { token, logger } = config;
  const attachments = await getMessageAttachments(token, channelId, messageId, logger);
  const imageAttachment = attachments.find(
    (a) => a.content_type?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(a.filename),
  );

  if (!imageAttachment) return false;

  const buffer = await downloadUrl(imageAttachment.url, logger);
  if (!buffer) return false;

  session.referenceImageUrl = bufferToDataUrl(buffer);
  return true;
}
