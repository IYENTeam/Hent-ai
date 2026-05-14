import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateImage, type GenerateOptions } from "@hent-ai/generate";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerOnboarding, type OnboardingConfig } from "./onboarding/index.js";
import { sendImageBufferMessage, sendTextMessage } from "./onboarding/discord-utils.js";

const LLM_TIMEOUT_MS = 15_000;

/**
 * Ensure a candidate path resolves to a location inside (or equal to) the
 * trusted root directory. Prevents path traversal via `imageDir` or
 * `emotionMap` values smuggling something like "../../etc/passwd".
 *
 * Returns the normalized absolute path on success, or null when the candidate
 * escapes the root. Both inputs may be relative or absolute; both are
 * normalized to absolute form using `resolve`.
 */
export function assertPathInside(root: string, candidate: string): string | null {
   const normalizedRoot = resolve(root);
   const normalizedCandidate = resolve(normalizedRoot, candidate);
   const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
   if (
     normalizedCandidate === normalizedRoot ||
     normalizedCandidate.startsWith(rootWithSep)
   ) {
     return normalizedCandidate;
   }
   return null;
 }

export type ApiType = "openai-completions" | "anthropic-messages";

export function detectApiType(apiFromConfig?: string): ApiType {
   if (apiFromConfig === "anthropic-messages") return "anthropic-messages";
   return "openai-completions";
 }

/**
 * Expand a value of the form `${ENV_VAR}` to `process.env.ENV_VAR`.
 * Returns the original string if no placeholder is present, or undefined when
 * the referenced env var is missing.
 */
export function expandEnvPlaceholder(value: string | undefined): string | undefined {
   if (!value) return undefined;
   const m = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i);
   if (!m) return value;
   return process.env[m[1]];
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

async function classifyCheerIntentViaOpenAI(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  text: string,
  signal: AbortSignal,
  logger: { warn: (...args: any[]) => void },
): Promise<boolean | null> {
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
          content: buildCheerIntentPrompt(text),
        },
      ],
      max_tokens: 10,
      temperature: 0,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    logger.warn(`emotion-image: OpenAI cheer intent returned ${response.status} from ${url}: ${body.slice(0, 500)}`);
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  const intent = extractBooleanIntent(content);
  if (intent === null) {
    logger.warn(`emotion-image: OpenAI cheer intent parse failed, raw="${content ?? "(no content)"}"`);
  }
  return intent;
}

async function classifyCheerIntentViaAnthropic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  text: string,
  signal: AbortSignal,
  logger: { warn: (...args: any[]) => void },
): Promise<boolean | null> {
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
          content: buildCheerIntentPrompt(text),
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    logger.warn(`emotion-image: Anthropic cheer intent returned ${response.status} from ${url}: ${body.slice(0, 500)}`);
    return null;
  }

  const data = (await response.json()) as {
    content?: Array<{ text?: string }>;
  };
  const content = data?.content?.[0]?.text;
  const intent = extractBooleanIntent(content);
  if (intent === null) {
    logger.warn(`emotion-image: Anthropic cheer intent parse failed, raw="${content ?? "(no content)"}"`);
  }
  return intent;
}

export async function detectCheerIntentWithLLM(
  classifierModel: string,
  text: string,
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
): Promise<boolean> {
  const slashIdx = classifierModel.indexOf("/");
  if (slashIdx === -1) {
    logger.warn(`emotion-image: cheer intent model "${classifierModel}" missing "/" separator`);
    return false;
  }
  const providerName = classifierModel.slice(0, slashIdx);
  const modelId = classifierModel.slice(slashIdx + 1);
  if (!providerName || !modelId) {
    logger.warn(`emotion-image: cheer intent model "${classifierModel}" could not be parsed`);
    return false;
  }

  const cfg = runtime.config.current();
  const providerCfg = cfg.models?.providers?.[providerName];
  if (!providerCfg?.baseUrl) {
    logger.warn(`emotion-image: cheer intent provider "${providerName}" not found or missing baseUrl in config`);
    return false;
  }

  let apiKey: string | undefined;
  try {
    const auth = await runtime.modelAuth.resolveApiKeyForProvider({
      provider: providerName,
      cfg: providerCfg,
    });
    apiKey = auth.apiKey;
  } catch (err) {
    logger.warn(`emotion-image: failed to resolve cheer intent apiKey for "${providerName}": ${err}`);
    return false;
  }

  if (!apiKey) {
    logger.warn(`emotion-image: no cheer intent apiKey resolved for provider "${providerName}"`);
    return false;
  }

  const baseUrl = providerCfg.baseUrl.replace(/\/+$/, "");
  const apiType: ApiType = detectApiType(providerCfg.api);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const result = apiType === "anthropic-messages"
      ? await classifyCheerIntentViaAnthropic(baseUrl, apiKey, modelId, text, controller.signal, logger)
      : await classifyCheerIntentViaOpenAI(baseUrl, apiKey, modelId, text, controller.signal, logger);
    return result ?? false;
  } catch (err) {
    logger.warn(`emotion-image: cheer intent LLM call error: ${err}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
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

type EmotionImageInput =
  | string
  | {
    file?: string;
    filename?: string;
    label?: string;
    weight?: number;
  };

type EmotionImageConfig = EmotionImageInput | EmotionImageInput[];

interface EmotionImageVariant {
  filename: string;
  label?: string;
  weight: number;
}

const DEFAULT_EMOTION_MAP: Record<string, EmotionImageConfig> = {
  happy: "happy.png",
  neutral: "neutral.png",
  loyalty: "loyalty.png",
  sorry: "sorry.png",
  confused: "confused.png",
  focused: "focused.png",
};

const LABEL_TOKEN_RE = /[\p{L}\p{N}]+/gu;
const FILENAME_LABEL_SEPARATORS_RE = /[-_\s]+/g;
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif)$/i;
const AUTO_LABEL_STOPWORDS = new Set([
  ...Object.keys(DEFAULT_EMOTION_MAP),
  "image",
  "img",
  "emotion",
  "variant",
]);

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

export interface CheerConfig {
  enabled?: boolean;
  character?: string;
  intentModel?: string;
  model?: string;
  size?: string;
}

export function buildCheerPrompt(character?: string): string {
  const subject = character?.trim()
    ? `Character: ${character.trim()}.`
    : "Character: use the same character as the reference image if provided; otherwise create a charming original Hent-ai mascot.";

  return [
    "Create a polished single-scene 2D anime illustration for cheering up the user.",
    subject,
    "Scene: the character warmly cheers for the viewer with an energetic pose, bright smile, direct eye contact, supportive body language, and celebratory props such as glow sticks, pom-poms, ribbons, or a small encouragement banner reading \"화이팅!\".",
    "Outfit: tasteful adult fanservice fashion with more visible skin, such as an off-shoulder top, crop top, short skirt, high slit dress, festival outfit, or swimsuit-inspired stage costume; stylish, confident, and non-explicit.",
    "Mood: uplifting, affectionate, playful fanservice energy, confidence boost, personal support from the character to the user, glamorous but wholesome.",
    "Style: modern Japanese visual novel CG art, bishoujo dating sim game illustration, high-quality 2D anime game CG, hand-drawn anime illustration, clean thin lineart, refined cel shading, soft ambient lighting, expressive glossy anime eyes, delicate facial features, cinematic composition.",
    "Safety requirements: adult character, tasteful and non-explicit, no nudity, no nipples, no genitals, no lingerie, no sexual act, no fetish focus, no minors, no explicit pose, no exposed underwear, no erotic text.",
    "Format requirements: single coherent illustration, square format, no panels, no character sheet, no turnaround views, no text other than the short Korean cheer banner if included.",
  ].join(" ");
}

export function normalizeEmotionImageConfig(config: EmotionImageConfig): EmotionImageVariant[] {
  const entries = Array.isArray(config) ? config : [config];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return [{ filename: entry, weight: 1 }];

    const filename = entry.file ?? entry.filename;
    if (!filename) return [];
    const label = entry.label ?? inferAutomaticImageLabel(filename);
    return [{
      filename,
      ...(label ? { label } : {}),
      weight: entry.weight && entry.weight > 0 ? entry.weight : 1,
    }];
  });
}

export function inferAutomaticImageLabel(filename: string): string | undefined {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const stem = basename.replace(IMAGE_EXTENSION_RE, "");
  const tokens = stem
    .split(FILENAME_LABEL_SEPARATORS_RE)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token && !AUTO_LABEL_STOPWORDS.has(token));

  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

export function imageLabelMatchesContext(label: string | undefined, contextText: string): boolean {
  if (!label || !contextText.trim()) return false;

  const labelText = label.trim().toLowerCase();
  const context = contextText.toLowerCase();
  if (!labelText) return false;
  if (context.includes(labelText)) return true;

  const labelTokens = labelText.match(LABEL_TOKEN_RE) ?? [];
  const contextTokens = new Set(context.match(LABEL_TOKEN_RE) ?? []);
  return labelTokens.some((token) => contextTokens.has(token));
}

export function selectEmotionImageVariant(
  variants: EmotionImageVariant[],
  random = Math.random,
  contextText = "",
): EmotionImageVariant | null {
  const pool = contextText
    ? variants.filter((variant) => imageLabelMatchesContext(variant.label, contextText))
    : [];
  const candidates = pool.length > 0 ? pool : variants;

  if (candidates.length === 0) return null;
  const totalWeight = candidates.reduce((sum, variant) => sum + variant.weight, 0);
  let cursor = random() * totalWeight;
  for (const variant of candidates) {
    cursor -= variant.weight;
    if (cursor <= 0) return variant;
  }
  return candidates[candidates.length - 1] ?? null;
}

function pngBufferToDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function extractBooleanIntent(content: string | undefined | null): boolean | null {
  if (!content) return null;

  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;

  if (["yes", "true", "y"].includes(normalized)) return true;
  if (["no", "false", "n"].includes(normalized)) return false;

  const unquoted = normalized.replace(/^(["'`\u2018\u2019\u201c\u201d]+)|(["'`\u2018\u2019\u201c\u201d]+)$/g, "").trim();
  if (["yes", "true", "y"].includes(unquoted)) return true;
  if (["no", "false", "n"].includes(unquoted)) return false;

  const match = /\b(yes|true|no|false)\b/i.exec(unquoted);
  if (!match) return null;
  return match[1].toLowerCase() === "yes" || match[1].toLowerCase() === "true";
}

function buildCheerIntentPrompt(text: string): string {
  return [
    "Decide whether the user's message is asking the character/bot to encourage, cheer up, comfort, support, motivate, or give emotional energy to the user.",
    "Return ONLY yes or no.",
    "Answer yes for indirect requests like being tired and wanting energy, wanting support, asking for encouragement, or asking the character to root for them.",
    "Answer no for thanks, normal greetings, status updates, or unrelated mentions of cheering.",
    `Message: ${text}`,
  ].join("\n");
}

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
  const resolvedApiKey = apiKey;

  const baseUrl = providerCfg.baseUrl.replace(/\/+$/, "");
  const apiType: ApiType = detectApiType(providerCfg.api);

  async function attemptOnce(): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      if (apiType === "anthropic-messages") {
        return await classifyEmotionViaAnthropic(baseUrl, resolvedApiKey, modelId, text, validEmotions, controller.signal, logger);
      }
      return await classifyEmotionViaOpenAI(baseUrl, resolvedApiKey, modelId, text, validEmotions, controller.signal, logger);
    } catch (err) {
      logger.warn(`emotion-image: LLM call error: ${err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  logger.warn(`emotion-image: calling ${apiType} at ${baseUrl}, model=${modelId}, apiKey len=${resolvedApiKey.length}`);

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

export async function handleCheerRequest(
  params: {
    token: string;
    channelId: string;
    imageDir: string;
    config: CheerConfig;
    onboardingConfig?: OnboardingConfig;
    logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  },
): Promise<void> {
  const { token, channelId, imageDir, config, onboardingConfig, logger } = params;
  const baseImagePath = assertPathInside(imageDir, "base.png");
  await sendTextMessage(
    token,
    channelId,
    "응원 이미지를 만들고 있어요. 잠깐만 기다려주세요!",
    logger,
  );

  try {
    const options: GenerateOptions = {
      prompt: buildCheerPrompt(config.character),
      model: config.model ?? onboardingConfig?.model,
      size: config.size ?? onboardingConfig?.size ?? "1024x1024",
      referenceImages:
        baseImagePath && existsSync(baseImagePath)
          ? [pngBufferToDataUrl(await readFile(baseImagePath))]
          : undefined,
    };
    const buffer = await generateImage(options);
    await sendImageBufferMessage(
      token,
      channelId,
      buffer,
      "cheer.png",
      "화이팅! 오늘도 충분히 잘하고 있어요.",
      logger,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await sendTextMessage(
      token,
      channelId,
      `응원 이미지 생성에 실패했어요: ${errMsg}`,
      logger,
    );
    logger.error(`emotion-image: cheer generation failed: ${err}`);
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
     const newFileIndex = 0;

      const imageBuffer = await readFile(imagePath);
     const filename = imagePath.split("/").pop() ?? "emotion.png";

     const boundary = `----EmotionImage${Date.now()}`;
     const parts: Buffer[] = [];

     const jsonPayload = JSON.stringify({
       content: existingContent,
       attachments: [
         ...existingAttachments,
         { id: newFileIndex, filename },
       ],
     });
     parts.push(Buffer.from(
       `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`
     ));

     parts.push(Buffer.from(
       `--${boundary}\r\nContent-Disposition: form-data; name="files[${newFileIndex}]"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
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

export { detectEmotionWithLLM, extractBooleanIntent, extractEmotion };
export default definePluginEntry({
  id: "emotion-image",
  name: "Emotion Image Attachment",
  description: "Auto-detect emotion in agent responses and attach matching images to Discord messages.",

  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as {
      enabled?: boolean;
      imageDir?: string;
      emotionMap?: Record<string, EmotionImageConfig>;
      defaultEmotion?: string;
      emotionRules?: Record<string, string[]>;
      classifierModel?: string;
      discordToken?: string;
      onboarding?: OnboardingConfig;
      cheer?: CheerConfig;
    };

    if (pluginConfig.enabled === false) return;

    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const imageDir = pluginConfig.imageDir
      ? resolve(pluginConfig.imageDir)
      : resolve(extensionDir, "..", "assets");

     const emotionMap: Record<string, EmotionImageVariant[]> = Object.fromEntries(
       Object.entries({
       ...DEFAULT_EMOTION_MAP,
       ...pluginConfig.emotionMap,
       }).map(([emotion, config]) => [emotion, normalizeEmotionImageConfig(config)]),
     );

     for (const [emotion, variants] of Object.entries(emotionMap)) {
       const safeVariants = variants.filter((variant) => {
         if (isAbsolute(variant.filename)) {
           api.logger.error(`emotion-image: emotionMap["${emotion}"]="${variant.filename}" must be a filename relative to imageDir, not an absolute path. Skipping.`);
           return false;
         }
         if (assertPathInside(imageDir, variant.filename) === null) {
           api.logger.error(`emotion-image: emotionMap["${emotion}"]="${variant.filename}" escapes imageDir="${imageDir}". Skipping.`);
           return false;
         }
         return true;
       });
       if (safeVariants.length === 0) {
         delete emotionMap[emotion];
       } else {
         emotionMap[emotion] = safeVariants;
       }
     }

     const validEmotions = Object.keys(emotionMap);
    const activeEmotion = pluginConfig.defaultEmotion ?? DEFAULT_EMOTION;
    const activeRules = buildEmotionRules(pluginConfig.emotionRules);
    const classifierModel = pluginConfig.classifierModel;

    if (classifierModel) {
      api.logger.info(`emotion-image: LLM classifier enabled with model="${classifierModel}"`);
    }

     const botToken =
       process.env.EMOTION_IMAGE_DISCORD_TOKEN ??
       expandEnvPlaceholder(pluginConfig.discordToken);

     if (!botToken) {
       api.logger.warn(
         `emotion-image: Discord token not configured. Set EMOTION_IMAGE_DISCORD_TOKEN env var ` +
         `or pluginConfig.discordToken (supports "\${ENV_VAR}" placeholder).`,
       );
       return;
     }

    api.logger.info(`emotion-image: token found (len=${botToken.length}), imageDir=${imageDir}`);

    const onboardingRuntime = registerOnboarding(api, botToken, imageDir, pluginConfig.onboarding ?? {});

      const cheerConfig = pluginConfig.cheer ?? {};
      const cheerEnabled = cheerConfig.enabled !== false;
      const cheerIntentModel = cheerConfig.intentModel ?? classifierModel;

      // Phase 1: On user message received, immediately send focused (thinking) image
      const thinkingVariant = selectEmotionImageVariant(emotionMap.focused ?? []);
      const thinkingImagePath = thinkingVariant ? assertPathInside(imageDir, thinkingVariant.filename) : null;

      if (cheerEnabled || (thinkingImagePath && existsSync(thinkingImagePath))) {
       api.on("message_received", async (event) => {
         const { content, metadata } = event as { content?: string; metadata?: Record<string, unknown> };
         if (!content || content.trim() === "NO_REPLY") return;

        // Extract Discord channel snowflake from metadata.to ("channel:ID" format)
        const rawTo = metadata?.to as string | undefined;
        if (!rawTo) return;
          const discordChannelId = rawTo.startsWith("channel:") ? rawTo.slice(8) : rawTo;
          if (!discordChannelId || !/^\d+$/.test(discordChannelId)) return;
          const userId = (metadata?.from as string | undefined) ?? "unknown";
          if (onboardingRuntime?.isOnboardingMessage(discordChannelId, userId, content)) return;

          if (
           cheerEnabled &&
           cheerIntentModel &&
           await detectCheerIntentWithLLM(cheerIntentModel, content, api.runtime, api.logger)
         ) {
           await handleCheerRequest({
              token: botToken,
             channelId: discordChannelId,
             imageDir,
             config: cheerConfig,
             onboardingConfig: pluginConfig.onboarding,
             logger: api.logger,
           });
           return;
         }

         if (!thinkingImagePath || !existsSync(thinkingImagePath)) return;

         api.logger.info(`emotion-image: received user msg, sending thinking image to channel=${discordChannelId}`);
         try {
            await sendImageMessage(botToken, discordChannelId, thinkingImagePath, api.logger);
        } catch (err) {
          api.logger.warn(`emotion-image: thinking image send failed: ${err}`);
        }
       }, { name: "emotion-image-thinking" });
     }

     const channelQueues = new Map<string, Promise<void>>();

     // Phase 2: On bot message sent, LLM classifies emotion and appends image
     api.on("message_sent", async (event) => {
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

          const finalVariant = selectEmotionImageVariant(
            emotionMap[finalEmotion] ?? emotionMap[activeEmotion] ?? normalizeEmotionImageConfig("neutral.png"),
            Math.random,
            cleaned,
          );
         if (!finalVariant) {
           api.logger.warn(`emotion-image: no image variants configured for "${finalEmotion}"; skipping`);
           return;
         }
         const finalImagePath = assertPathInside(imageDir, finalVariant.filename);
         if (!finalImagePath) {
           api.logger.warn(`emotion-image: resolved path for "${finalEmotion}" escapes imageDir; skipping`);
           return;
         }
         if (!existsSync(finalImagePath)) {
           api.logger.warn(`emotion-image: image not found: ${finalImagePath}`);
           return;
         }

         api.logger.info(`emotion-image: appending ${finalEmotion} image${finalVariant.label ? ` (${finalVariant.label})` : ""} for msg=${messageId}`);
          await appendImageToMessage(botToken, channelId, messageId, finalImagePath, api.logger);
       };

       const prev = channelQueues.get(channelId) ?? Promise.resolve();
       const next = prev.then(classifyAndAppend).catch((err) => {
         api.logger.error(`emotion-image: classifyAndAppend failed for msg=${messageId}: ${err}`);
       });
       channelQueues.set(channelId, next);
       next.finally(() => {
         if (channelQueues.get(channelId) === next) channelQueues.delete(channelId);
       });
    }, { name: "emotion-image-sent" });
  },
});
