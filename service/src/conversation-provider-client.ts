import type { ConversationPrompt } from "./conversation-contracts.js";

export type ConversationProviderClientConfig = {
  readonly endpoint: string;
  readonly token: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly extraHeaders?: Record<string, string>;
  readonly extraBody?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
};

export interface ConversationProviderClient {
  readonly complete: (prompt: ConversationPrompt, opts?: { readonly model?: string }) => Promise<string | null>;
}

type EnvMap = Readonly<Record<string, string | undefined>>;

const ENV_KEYS = {
  endpoint: "HENT_AI_CONVERSATION_PROVIDER_ENDPOINT",
  token: "HENT_AI_CONVERSATION_PROVIDER_TOKEN",
  model: "HENT_AI_CONVERSATION_PROVIDER_MODEL",
  timeoutMs: "HENT_AI_CONVERSATION_PROVIDER_TIMEOUT_MS",
  extraHeaders: "HENT_AI_CONVERSATION_PROVIDER_EXTRA_HEADERS",
  extraBody: "HENT_AI_CONVERSATION_PROVIDER_EXTRA_BODY",
} as const;

const DEFAULT_TIMEOUT_MS = 20_000;

export function loadConversationProviderConfigFromEnv(env: EnvMap = process.env): ConversationProviderClientConfig | null {
  const endpoint = textEnv(env[ENV_KEYS.endpoint]);
  const token = textEnv(env[ENV_KEYS.token]);
  const model = textEnv(env[ENV_KEYS.model]);
  if (!endpoint || !token || !model) return null;
  return {
    endpoint,
    token,
    model,
    timeoutMs: positiveIntegerEnv(env[ENV_KEYS.timeoutMs], DEFAULT_TIMEOUT_MS),
    extraHeaders: stringRecordEnv(env[ENV_KEYS.extraHeaders], ENV_KEYS.extraHeaders),
    extraBody: recordEnv(env[ENV_KEYS.extraBody], ENV_KEYS.extraBody),
  };
}

export function createConversationProviderClient(config: ConversationProviderClientConfig): ConversationProviderClient {
  const endpoint = new URL(config.endpoint);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  return {
    async complete(prompt, opts) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.extraHeaders ?? {}),
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({
            ...(config.extraBody ?? {}),
            model: opts?.model ?? config.model,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return extractChatCompletionContent(await response.json());
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function extractChatCompletionContent(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const choices = Array.isArray(value.choices) ? value.choices : null;
  const firstChoice = choices?.[0];
  if (!isRecord(firstChoice)) return null;
  const message = isRecord(firstChoice.message) ? firstChoice.message : null;
  const content = message?.content;
  return typeof content === "string" && content.trim().length > 0 ? content : null;
}

function textEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function recordEnv(value: string | undefined, envKey: string): Record<string, unknown> | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed)) throw new Error(`${envKey} must be a JSON object`);
  return parsed;
}

function stringRecordEnv(value: string | undefined, envKey: string): Record<string, string> | undefined {
  const parsed = recordEnv(value, envKey);
  if (!parsed) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string") throw new Error(`${envKey}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
