import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  buildResponsesRequest,
  extractImageGeneration,
  parseSseText,
} from "god-tibo-imagen";

export class CodexHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CodexHttpError";
  }
}

export class CodexTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexTimeoutError";
  }
}

const MAX_REFERENCE_IMAGES = 3;
const MAX_IMAGE_DIMENSION = 768;
const FETCH_TIMEOUT_MS = 90_000;
const MAX_SAFETY_REPHRASE_ATTEMPTS = 3;

const SAFETY_REJECTION_KEYWORDS = [
  "content_policy",
  "content policy",
  "safety",
  "rejected",
  "unsafe",
  "policy_violation",
  "content_filter",
];

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface CodexSession {
  accessToken: string;
  accountId: string;
  installationId: string | null;
}

interface ParsedSse {
  events: Array<{ event?: string; data?: { type?: string; response?: { output?: unknown[] } } }>;
  items: unknown[];
  responseId: string | null;
}

/**
 * Inject this to auto-rephrase prompts on content-policy rejections.
 * Keeps codex.ts provider-agnostic — the caller binds their LLM session.
 */
export interface RephraseProvider {
  rephrase: (prompt: string, rejectionReason: string) => Promise<string>;
}

export interface GenerateOptions {
  prompt: string;
  model?: string;
  size?: string;
  /** Data-URL encoded reference images. Maximum 3 allowed. */
  referenceImages?: string[];
  rephraseProvider?: RephraseProvider;
}

async function resizeImageIfNeeded(
  dataUrl: string,
  maxDimension: number = MAX_IMAGE_DIMENSION,
): Promise<string> {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return dataUrl;

  const base64Data = dataUrl.slice(commaIdx + 1);
  const inputBuffer = Buffer.from(base64Data, "base64");

  const metadata = await sharp(inputBuffer).metadata();
  const { width, height } = metadata;

  if (!width || !height) return dataUrl;
  if (width <= maxDimension && height <= maxDimension) return dataUrl;

  const resizedBuffer = await sharp(inputBuffer)
    .resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  return `data:image/png;base64,${resizedBuffer.toString("base64")}`;
}

async function preprocessReferenceImages(
  images: string[] | undefined,
): Promise<string[] | undefined> {
  if (!images || images.length === 0) return undefined;

  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `Maximum ${MAX_REFERENCE_IMAGES} reference images allowed, got ${images.length}`,
    );
  }

  return Promise.all(images.map((img) => resizeImageIfNeeded(img)));
}

async function loadSession(): Promise<CodexSession> {
  const authPath = join(homedir(), ".codex", "auth.json");
  let data: string;
  try {
    data = await readFile(authPath, "utf-8");
  } catch {
    throw new Error(
      `Cannot read ${authPath}. Log in with the Codex CLI first: codex login`,
    );
  }
  const auth: CodexAuth = JSON.parse(data);
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!accessToken || !accountId) {
    throw new Error(
      `Missing access_token or account_id in ${authPath}. Re-authenticate: codex login`,
    );
  }
  return { accessToken, accountId, installationId: null };
}

function isSafetyRejection(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return SAFETY_REJECTION_KEYWORDS.some((kw) => msg.includes(kw));
}

type ToolChoiceMode = "auto" | "required";

async function attempt(
  options: GenerateOptions,
  session: CodexSession,
  toolChoice: ToolChoiceMode,
  processedImages: string[] | undefined,
): Promise<Buffer> {
  const request = buildResponsesRequest({
    baseUrl: "https://chatgpt.com/backend-api/codex",
    session,
    prompt: options.prompt,
    model: options.model ?? "gpt-5.4",
    originator: "codex_cli_rs",
    images: processedImages,
    ...(options.size ? { size: options.size } : {}),
  });

  const body = request.body as Record<string, unknown>;
  if (toolChoice === "required") {
    body.tool_choice = { type: "image_generation" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new CodexTimeoutError(
        `Codex backend request timed out after ${FETCH_TIMEOUT_MS / 1000}s. ` +
        `Try reducing reference image count or size.`,
      );
    }
    throw err;
  }
  clearTimeout(timer);

  if (!response.ok) {
    const text = await response.text();
    throw new CodexHttpError(
      response.status,
      `Codex backend returned HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  const responseBody = await response.text();
  const trimmed = responseBody.trimStart();
  const contentType = response.headers.get("content-type") ?? "";
  const isSse =
    contentType.includes("text/event-stream") ||
    trimmed.startsWith("event:") ||
    trimmed.startsWith("data:");

  let parsed: ParsedSse;
  if (isSse) {
    parsed = parseSseText(responseBody) as ParsedSse;
    for (const event of parsed.events) {
      const d = event?.data as
        | { type?: string; response?: { output?: unknown[] } }
        | undefined;
      if (d?.type === "response.completed" && Array.isArray(d.response?.output)) {
        parsed.items.push(...d.response.output);
      }
    }
  } else {
    const payload = JSON.parse(responseBody);
    parsed = {
      events: [],
      items: Array.isArray(payload?.output) ? payload.output : [],
      responseId: payload?.id ?? null,
    };
  }

  const generation = extractImageGeneration(parsed);
  return Buffer.from(generation.resultBase64, "base64");
}

async function attemptWithToolChoiceFallback(
  options: GenerateOptions,
  session: CodexSession,
  processedImages: string[] | undefined,
): Promise<Buffer> {
  try {
    return await attempt(options, session, "auto", processedImages);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("without an image_generation_call")
    ) {
      return await attempt(options, session, "required", processedImages);
    }
    throw err;
  }
}

export async function generateImage(options: GenerateOptions): Promise<Buffer> {
  const session = await loadSession();
  const processedImages = await preprocessReferenceImages(options.referenceImages);

  let currentPrompt = options.prompt;
  let lastError: Error | undefined;

  for (let i = 0; i < MAX_SAFETY_REPHRASE_ATTEMPTS; i++) {
    try {
      const currentOptions: GenerateOptions = { ...options, prompt: currentPrompt };
      return await attemptWithToolChoiceFallback(currentOptions, session, processedImages);
    } catch (err) {
      if (!(err instanceof Error)) throw err;

      if (isSafetyRejection(err) && options.rephraseProvider && i < MAX_SAFETY_REPHRASE_ATTEMPTS - 1) {
        lastError = err;
        console.warn(
          `[hent-ai/generate] Safety rejection (attempt ${i + 1}/${MAX_SAFETY_REPHRASE_ATTEMPTS}). Rephrasing...`,
        );
        currentPrompt = await options.rephraseProvider.rephrase(currentPrompt, err.message);
        continue;
      }

      throw err;
    }
  }

  throw lastError ?? new Error("Image generation failed after all rephrase attempts");
}
