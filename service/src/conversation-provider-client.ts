import { Buffer } from "node:buffer";
import type { ConversationPrompt } from "./conversation-contracts.js";

const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

export type ConversationProviderCompletion =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export type ConversationProviderClient = {
  readonly complete: (
    prompt: ConversationPrompt,
    options?: { readonly model?: string; readonly signal?: AbortSignal },
  ) => Promise<ConversationProviderCompletion>;
};

export type OpenAiConversationProviderClientConfig = {
  readonly endpoint: URL | string;
  readonly token: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly extraHeaders?: Record<string, string>;
  readonly extraBody?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
};

export function createOpenAiConversationProviderClient(config: OpenAiConversationProviderClientConfig): ConversationProviderClient {
  const endpoint = new URL(config.endpoint.toString());
  if (!config.token.trim()) throw new Error("conversation provider token is required");
  if (!config.model.trim()) throw new Error("conversation provider model is required");
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("conversation provider timeout must be a positive integer");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  return {
    async complete(prompt, options = {}) {
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            ...(config.extraHeaders ?? {}),
            "content-type": "application/json",
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({
            ...(config.extraBody ?? {}),
            model: options.model ?? config.model,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) return invalid("provider request failed");
        const content = readStrictChatCompletionsContent(await readBoundedJson(response));
        return content === null ? invalid("provider response was invalid") : { kind: "ok", content };
      } catch {
        return invalid("provider request failed");
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("provider response body was missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel("provider response exceeded byte cap");
        throw new Error("provider response exceeded byte cap");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function readStrictChatCompletionsContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") return null;
  return choice.message.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(diagnostic: string): ConversationProviderCompletion {
  return { kind: "invalid", diagnostic };
}
