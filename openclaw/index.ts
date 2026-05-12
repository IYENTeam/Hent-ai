import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolve, dirname, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const LLM_TIMEOUT_MS = 15_000;

export type ApiType = "openai-completions" | "anthropic-messages";

export function detectApiType(apiFromConfig?: string): ApiType {
  if (apiFromConfig === "anthropic-messages") return "anthropic-messages";
  return "openai-completions";
}

/**
 * Extract a valid emotion from LLM response text with robust parsing.
 * Handles exact matches, surrounding quotes, extra text/whitespace, and multi-line responses.
 */
function extractEmotion(
  content: string | undefined | null,
  validEmotions: string[],
): string | null {
  if (!content) return null;

  const trimmed = content.trim().toLowerCase();
  if (!trimmed) return null;

  if (validEmotions.includes(trimmed)) return trimmed;

  for (const line of trimmed.split("\n")) {
    const clean = line.trim();
    if (validEmotions.includes(clean)) return clean;
  }

  const unquoted = trimmed.replace(/^["'`\u2018\u2019\u201c\u201d]+|["'`\u2018\u2019\u201c\u201d]+$/g, "").trim();
  if (validEmotions.includes(unquoted)) return unquoted;

  for (const line of unquoted.split("\n")) {
    const clean = line.trim();
    if (validEmotions.includes(clean)) return clean;
  }

  let earliestMatch: { emotion: string; index: number } | null = null;
  for (const emotion of validEmotions) {
    const re = new RegExp(`\\b${emotion}\\b`, "i");
    const match = re.exec(content);
    if (match && (earliestMatch === null || match.index < earliestMatch.index)) {
      earliestMatch = { emotion, index: match.index };
    }
  }
  if (earliestMatch) return earliestMatch.emotion;

  return null;
}

async function classifyEmotionViaOpenAI(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  text: string,
  validEmotions: string[],
  signal: AbortSignal,
  logger: { warn: (...args: any[]) => void },
): Promise<string | null> {
  const emotionList = validEmotions.map((e) => `"${e}"`).join(", ");
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "OpenClaw-EmotionImage/1.0",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: "user",
          content: `Classify the emotion of this message into exactly one of: ${emotionList}. Reply with ONLY the emotion word, nothing else.\n\nMessage: ${text}`,
        },
      ],
      max_tokens: 10,
      temperature: 0,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    logger.warn(`emotion-image: OpenAI API returned ${response.status} from ${url}: ${body.slice(0, 500)}`);
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  const emotion = extractEmotion(content, validEmotions);
  if (!emotion) {
    logger.warn(`emotion-image: OpenAI response parse failed, raw="${content ?? "(no content)"}", valid=[${validEmotions}]`);
  }
  return emotion;
}

async function classifyEmotionViaAnthropic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  text: string,
  validEmotions: string[],
  signal: AbortSignal,
  logger: { warn: (...args: any[]) => void },
): Promise<string | null> {
  const emotionList = validEmotions.map((e) => `"${e}"`).join(", ");
  const url = `${baseUrl.replace(/\/+$/, "")}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "User-Agent": "OpenClaw-EmotionImage/1.0",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 10,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Classify the emotion of this message into exactly one of: ${emotionList}. Reply with ONLY the emotion word, nothing else.\n\nMessage: ${text}`,
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    logger.warn(`emotion-image: Anthropic API returned ${response.status} from ${url}: ${body.slice(0, 500)}`);
    return null;
  }

  const data = (await response.json()) as {
    content?: Array<{ text?: string }>;
  };
  const content = data?.content?.[0]?.text;
  const emotion = extractEmotion(content, validEmotions);
  if (!emotion) {
    logger.warn(`emotion-image: Anthropic response parse failed, raw="${content ?? "(no content)"}", valid=[${validEmotions}]`);
  }
  return emotion;
}

/**
 * Emotion Image Plugin v3
 *
 * Works at the Discord gateway level:
 * 1. Hooks into message_sent to detect outbound bot messages
 * 2. Classifies emotion via LLM or keyword pattern matching
 * 3. Edits the original message via Discord REST API to attach an image
 *
 * No OpenClaw core patches required.
 */

const DEFAULT_EMOTION_MAP: Record<string, string> = {
  happy: "happy.png",
  neutral: "neutral.png",
  loyalty: "loyalty.png",
  sorry: "sorry.png",
  confused: "confused.png",
  focused: "focused.png",
};

const EMOTION_RULES: Array<{ emotion: string; patterns: RegExp[] }> = [
  {
    emotion: "sorry",
    patterns: [
      /sorry|apolog|my bad|mistake|messed up|regret|oops/i,
    ],
  },
  {
    emotion: "happy",
    patterns: [
      /done|complete|succeed|fixed|shipped|great|awesome|excellent|perfect|nailed|pass|resolved|✅|🎉|🔥/i,
      /proud|happy|fantastic|wonderful|congrats|celebrate|woohoo|yay/i,
    ],
  },
  {
    emotion: "confused",
    patterns: [
      /confused|unclear|not sure|strange|unknown cause|weird|unexpected/i,
      /question|how do we|what should|any idea/i,
    ],
  },
  {
    emotion: "focused",
    patterns: [
      /investigating|debugging|analyzing|implementing|working on|coding|building/i,
      /in progress|checking|processing|deploying|testing|verifying/i,
    ],
  },
  {
    emotion: "loyalty",
    patterns: [
      /got it|understood|on it|yes sir|will do|right away|hello|hi there/i,
    ],
  },
];

const DEFAULT_EMOTION = "neutral";

/**
 * Attempt LLM-based emotion classification via the configured provider/model.
 *
 * Returns the detected emotion word when the LLM call succeeds, or null when
 * it fails or times out so the caller can fall back to rule-based detection.
 */
async function detectEmotionWithLLM(
  classifierModel: string,
  text: string,
  validEmotions: string[],
  runtime: {
    config: {
      current: () => { models?: { providers?: Record<string, { baseUrl?: string; api?: string }> } };
    };
    modelAuth: {
      resolveApiKeyForProvider: (params: {
        provider: string;
        cfg?: unknown;
      }) => Promise<{ apiKey?: string }>;
    };
  },
  logger: { warn: (...args: any[]) => void },
): Promise<string | null> {
  const slashIdx = classifierModel.indexOf("/");
  if (slashIdx === -1) {
    logger.warn(`emotion-image: classifierModel "${classifierModel}" missing "/" separator`);
    return null;
  }
  const providerName = classifierModel.slice(0, slashIdx);
  const modelId = classifierModel.slice(slashIdx + 1);
  if (!providerName || !modelId) {
    logger.warn(`emotion-image: classifierModel "${classifierModel}" could not be parsed`);
    return null;
  }

  const cfg = runtime.config.current();
  const providerCfg = cfg?.models?.providers?.[providerName];
  if (!providerCfg?.baseUrl) {
    logger.warn(`emotion-image: provider "${providerName}" not found or missing baseUrl in config`);
    return null;
  }

  let apiKey: string | undefined;
  try {
    const auth = await runtime.modelAuth.resolveApiKeyForProvider({
      provider: providerName,
      cfg: cfg as unknown as Record<string, unknown> | undefined,
    });
    apiKey = auth.apiKey;
  } catch (err) {
    logger.warn(`emotion-image: failed to resolve apiKey for "${providerName}": ${err}`);
    return null;
  }

  if (!apiKey) {
    logger.warn(`emotion-image: no apiKey resolved for provider "${providerName}"`);
    return null;
  }

  const baseUrl = providerCfg.baseUrl.replace(/\/+$/, "");
  const apiType: ApiType = detectApiType(providerCfg.api);

  async function attemptOnce(): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      if (apiType === "anthropic-messages") {
        return await classifyEmotionViaAnthropic(baseUrl, apiKey, modelId, text, validEmotions, controller.signal, logger);
      }
      return await classifyEmotionViaOpenAI(baseUrl, apiKey, modelId, text, validEmotions, controller.signal, logger);
    } catch (err) {
      logger.warn(`emotion-image: LLM call error: ${err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  logger.warn(`emotion-image: calling ${apiType} at ${baseUrl}, model=${modelId}, apiKey len=${apiKey.length}`);

  let emotion = await attemptOnce();
  if (emotion === null) {
    logger.warn(`emotion-image: LLM returned null, retrying once...`);
    emotion = await attemptOnce();
  }

  logger.warn(`emotion-image: LLM result=${JSON.stringify(emotion)}`);
  if (emotion) {
    logger.warn(`emotion-image: LLM classified emotion="${emotion}" for classifierModel="${classifierModel}"`);
  }
  return emotion;
}

export const MEDIA_LINE_RE = /\nMEDIA:\S+/g;

export function detectEmotion(
  text: string,
  rules: Array<{ emotion: string; patterns: RegExp[] }> = EMOTION_RULES,
  fallback: string = DEFAULT_EMOTION,
): string {
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) return rule.emotion;
    }
  }
  return fallback;
}

export async function editMessageWithImage(
   token: string,
   channelId: string,
   messageId: string,
   originalContent: string,
   imagePath: string,
   logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
 ) {
   try {
     const imageBuffer = await readFile(imagePath);
    const filename = imagePath.split("/").pop() ?? "emotion.png";

    // Build multipart/form-data
    const boundary = `----EmotionImage${Date.now()}`;
    const parts: Buffer[] = [];

    // JSON payload part
    const jsonPayload = JSON.stringify({
      content: originalContent,
      attachments: [{ id: 0, filename }],
    });
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`
    ));

    // File part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
    ));
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!res.ok) {
      const text = await res.text();
      logger.warn(`emotion-image: Discord edit failed ${res.status}: ${text.slice(0, 200)}`);
    } else {
      logger.info(`emotion-image: attached ${filename} to message ${messageId}`);
    }
  } catch (err) {
    logger.error(`emotion-image: edit error: ${err}`);
  }
}

export async function sendImageMessage(
   token: string,
   channelId: string,
   imagePath: string,
   logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
 ) {
   try {
     const imageBuffer = await readFile(imagePath);
    const filename = imagePath.split("/").pop() ?? "emotion.png";

    const boundary = `----EmotionImage${Date.now()}`;
    const parts: Buffer[] = [];

    const jsonPayload = JSON.stringify({ content: "" });
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`
    ));

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
    ));
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!res.ok) {
      const text = await res.text();
      logger.warn(`emotion-image: send image failed ${res.status}: ${text.slice(0, 200)}`);
    } else {
      logger.info(`emotion-image: sent ${filename} to channel ${channelId}`);
    }
  } catch (err) {
    logger.error(`emotion-image: send image error: ${err}`);
  }
}

export async function appendImageToMessage(
  token: string,
  channelId: string,
  messageId: string,
  imagePath: string,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
) {
  try {
    // GET current message to preserve existing content and attachments
    const getRes = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    if (!getRes.ok) {
      const errText = await getRes.text();
      logger.warn(`emotion-image: GET message failed ${getRes.status}: ${errText.slice(0, 200)}`);
      return;
    }
    const msg = (await getRes.json()) as {
      content?: string;
      attachments?: Array<{ id: string; filename: string }>;
    };

    const existingContent = msg.content ?? "";
    const existingAttachments = (msg.attachments ?? []).map((a) => ({ id: a.id }));
    const newAttachmentIdx = existingAttachments.length;

     const imageBuffer = await readFile(imagePath);
    const filename = imagePath.split("/").pop() ?? "emotion.png";

    const boundary = `----EmotionImage${Date.now()}`;
    const parts: Buffer[] = [];

    const jsonPayload = JSON.stringify({
      content: existingContent,
      attachments: [
        ...existingAttachments,
        { id: newAttachmentIdx, filename },
      ],
    });
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`
    ));

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[${newAttachmentIdx}]"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
    ));
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!res.ok) {
      const text = await res.text();
      logger.warn(`emotion-image: append image failed ${res.status}: ${text.slice(0, 200)}`);
    } else {
      logger.info(`emotion-image: appended ${filename} to message ${messageId}`);
    }
  } catch (err) {
    logger.error(`emotion-image: append error: ${err}`);
  }
}

export async function editMessageWithTwoImages(
   token: string,
   channelId: string,
   messageId: string,
   originalContent: string,
   imagePath1: string,
   imagePath2: string,
   logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
 ) {
   try {
     const [imageBuffer1, imageBuffer2] = await Promise.all([
       readFile(imagePath1),
       readFile(imagePath2),
     ]);
    const filename1 = imagePath1.split("/").pop() ?? "emotion1.png";
    const filename2 = imagePath2.split("/").pop() ?? "emotion2.png";

    const boundary = `----EmotionImage${Date.now()}`;
    const parts: Buffer[] = [];

    // JSON payload with two attachments
    const jsonPayload = JSON.stringify({
      content: originalContent,
      attachments: [
        { id: 0, filename: filename1 },
        { id: 1, filename: filename2 },
      ],
    });
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`
    ));

    // File 1
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename1}"\r\nContent-Type: image/png\r\n\r\n`
    ));
    parts.push(imageBuffer1);
    parts.push(Buffer.from("\r\n"));

    // File 2
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[1]"; filename="${filename2}"\r\nContent-Type: image/png\r\n\r\n`
    ));
    parts.push(imageBuffer2);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!res.ok) {
      const text = await res.text();
      logger.warn(`emotion-image: Discord two-image edit failed ${res.status}: ${text.slice(0, 200)}`);
    } else {
      logger.info(`emotion-image: attached ${filename1}+${filename2} to message ${messageId}`);
    }
  } catch (err) {
    logger.error(`emotion-image: two-image edit error: ${err}`);
  }
}

export function buildEmotionRules(
  customRules?: Record<string, string[]>,
): Array<{ emotion: string; patterns: RegExp[] }> {
  if (!customRules || Object.keys(customRules).length === 0) return EMOTION_RULES;

  const merged: Record<string, RegExp[]> = {};

  for (const rule of EMOTION_RULES) {
    merged[rule.emotion] = [...rule.patterns];
  }

  for (const [emotion, keywords] of Object.entries(customRules)) {
    const patterns = keywords.map((kw) => new RegExp(kw, "i"));
    if (merged[emotion]) {
      merged[emotion] = [...merged[emotion], ...patterns];
    } else {
      merged[emotion] = patterns;
    }
  }

  return Object.entries(merged).map(([emotion, patterns]) => ({ emotion, patterns }));
}

export { detectEmotionWithLLM, extractEmotion };
export default definePluginEntry({
  id: "emotion-image",
  name: "Emotion Image Attachment",
  description: "Auto-detect emotion in agent responses and attach matching images to Discord messages.",

  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as {
      enabled?: boolean;
      imageDir?: string;
      emotionMap?: Record<string, string>;
      defaultEmotion?: string;
      emotionRules?: Record<string, string[]>;
      classifierModel?: string;
    };

    if (pluginConfig.enabled === false) return;

    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const imageDir = pluginConfig.imageDir
      ? resolve(pluginConfig.imageDir)
      : resolve(extensionDir, "..", "assets");

    const emotionMap: Record<string, string> = {
      ...DEFAULT_EMOTION_MAP,
      ...pluginConfig.emotionMap,
    };

    const validEmotions = Object.keys(emotionMap);
    const activeEmotion = pluginConfig.defaultEmotion ?? DEFAULT_EMOTION;
    const activeRules = buildEmotionRules(pluginConfig.emotionRules);
    const classifierModel = pluginConfig.classifierModel;

    if (classifierModel) {
      api.logger.info(`emotion-image: LLM classifier enabled with model="${classifierModel}"`);
    }

    // Discord bot token: env var → config file lookup
    let botToken = process.env.EMOTION_IMAGE_DISCORD_TOKEN;
    if (!botToken) {
      try {
        const cfgPath = resolve(process.env.HOME ?? "~", ".openclaw/openclaw.json");
        const rawCfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        const accounts = rawCfg?.channels?.discord?.accounts;
        if (accounts) {
          const firstAccount = Object.values(accounts as Record<string, { token?: string }>)
            .find((a) => a?.token);
          botToken = firstAccount?.token;
        }
      } catch {}
    }

    if (!botToken) {
      api.logger.warn(`emotion-image: Discord token not found. Set EMOTION_IMAGE_DISCORD_TOKEN env var.`);
      return;
    }

    api.logger.info(`emotion-image: token found (len=${botToken.length}), imageDir=${imageDir}`);

    // Phase 1: On user message received, immediately send focused (thinking) image
    const thinkingFilename = emotionMap["focused"] ?? "focused.png";
    const thinkingImagePath = resolve(imageDir, thinkingFilename);

    if (existsSync(thinkingImagePath)) {
      api.on("message_received", async (event, ctx) => {
        const { content, metadata } = event as { content?: string; metadata?: Record<string, unknown> };
        if (!content || content.trim() === "NO_REPLY") return;

        // Extract Discord channel snowflake from metadata.to ("channel:ID" format)
        const rawTo = metadata?.to as string | undefined;
        if (!rawTo) return;
        const discordChannelId = rawTo.startsWith("channel:") ? rawTo.slice(8) : rawTo;
        if (!discordChannelId || !/^\d+$/.test(discordChannelId)) return;

        api.logger.info(`emotion-image: received user msg, sending thinking image to channel=${discordChannelId}`);
        try {
          await sendImageMessage(botToken!, discordChannelId, thinkingImagePath, api.logger);
        } catch (err) {
          api.logger.warn(`emotion-image: thinking image send failed: ${err}`);
        }
      }, { name: "emotion-image-thinking" });
    }

    // Phase 2: On bot message sent, LLM classifies emotion and appends image
    api.on("message_sent", async (event, ctx) => {
      const {
        to,
        content,
        success,
        messageId,
      } = event as {
        to?: string;
        content?: string;
        success?: boolean;
        messageId?: string;
        metadata?: Record<string, unknown>;
      };

      if (!success || !messageId || !content || !to) return;

      // Skip NO_REPLY messages
      if (content.trim() === "NO_REPLY") return;

      // Strip MEDIA: lines before emotion detection
      const cleaned = content.replace(MEDIA_LINE_RE, "").trimEnd();

      // Strip channel: prefix from to field (OpenClaw passes "channel:ID" format)
      const channelId = to.startsWith("channel:") ? to.slice(8) : to;

      // LLM classifies emotion and appends result image to the sent message
      const classifyAndAppend = async () => {
        let finalEmotion: string;
        if (pluginConfig.classifierModel) {
          try {
            api.logger.info(`emotion-image: LLM classification starting for msg=${messageId}`);
            const llmEmotion = await detectEmotionWithLLM(
              pluginConfig.classifierModel,
              cleaned,
              validEmotions,
              api.runtime,
              api.logger,
            );
            api.logger.info(`emotion-image: LLM result=${llmEmotion} for msg=${messageId}`);
            finalEmotion = llmEmotion ?? detectEmotion(cleaned, activeRules, activeEmotion);
          } catch (err) {
            api.logger.warn(`emotion-image: LLM threw: ${err}`);
            finalEmotion = detectEmotion(cleaned, activeRules, activeEmotion);
          }
        } else {
          finalEmotion = detectEmotion(cleaned, activeRules, activeEmotion);
        }

        const finalFilename = emotionMap[finalEmotion] ?? emotionMap[activeEmotion] ?? "neutral.png";
        const finalImagePath = resolve(imageDir, finalFilename);
        if (!existsSync(finalImagePath)) {
          api.logger.warn(`emotion-image: image not found: ${finalImagePath}`);
          return;
        }

        api.logger.info(`emotion-image: appending ${finalEmotion} image for msg=${messageId}`);
        await appendImageToMessage(botToken!, channelId, messageId, finalImagePath, api.logger);
      };
      classifyAndAppend();
    }, { name: "emotion-image-sent" });
  },
});
