import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildResponsesRequest,
  extractImageGeneration,
  parseSseText,
} from "god-tibo-imagen";

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

export interface GenerateOptions {
  prompt: string;
  model?: string;
  size?: string;
  referenceImages?: string[];
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

type ToolChoiceMode = "auto" | "required";

async function attempt(
  options: GenerateOptions,
  session: CodexSession,
  toolChoice: ToolChoiceMode,
): Promise<Buffer> {
  const request = buildResponsesRequest({
    baseUrl: "https://chatgpt.com/backend-api/codex",
    session,
    prompt: options.prompt,
    model: options.model ?? "gpt-5.4",
    originator: "codex_cli_rs",
    images: options.referenceImages,
    ...(options.size ? { size: options.size } : {}),
  });

  const body = request.body as Record<string, unknown>;
  if (toolChoice === "required") {
    body.tool_choice = { type: "image_generation" };
  }

  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
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

export async function generateImage(options: GenerateOptions): Promise<Buffer> {
  const session = await loadSession();

  try {
    return await attempt(options, session, "auto");
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("without an image_generation_call")
    ) {
      return await attempt(options, session, "required");
    }
    throw err;
  }
}
