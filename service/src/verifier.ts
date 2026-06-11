export type VerifierRequest = {
  channelId?: string;
  finalText: string;
  validEmotions: string[];
  metadata?: Record<string, unknown>;
};

export type VerifierJudgment = {
  emotion: string;
  confidence?: number;
  reason?: string;
};

export type FinalResponseVerifier = {
  verify(request: VerifierRequest): Promise<VerifierJudgment | null>;
};

export type FetchLike = typeof fetch;

export type VerifierProviderKind = "openai-chat-completions" | "vm4-closedrouter";

export type ChatCompletionsVerifierBodyMapping = {
  modelOrRouteField?: string;
  requestField?: string;
  finalTextField?: string;
  validEmotionsField?: string;
  channelIdField?: string;
  metadataField?: string;
};

export type OpenAiChatCompletionsVerifierConfig = {
  providerKind: "openai-chat-completions";
  endpoint: URL | string;
  token: string;
  modelOrRoute: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
  bodyMapping?: ChatCompletionsVerifierBodyMapping;
  extraBody?: Record<string, unknown>;
  fetchImpl?: FetchLike;
};

export type VerifierProviderConfig = OpenAiChatCompletionsVerifierConfig;

export type RemoteFinalResponseVerifierOptions = {
  url: URL | string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

const DEFAULT_VERIFIER_TIMEOUT_MS = 5_000;
const DEFAULT_BODY_MAPPING: Required<ChatCompletionsVerifierBodyMapping> = {
  modelOrRouteField: "model",
  requestField: "input",
  finalTextField: "finalText",
  validEmotionsField: "validEmotions",
  channelIdField: "channelId",
  metadataField: "metadata",
};

const ENV_KEYS = {
  providerKind: "HENT_AI_VERIFIER_PROVIDER_KIND",
  endpoint: "HENT_AI_VERIFIER_ENDPOINT",
  token: "HENT_AI_VERIFIER_TOKEN",
  modelOrRoute: "HENT_AI_VERIFIER_MODEL_OR_ROUTE",
  timeoutMs: "HENT_AI_VERIFIER_TIMEOUT_MS",
  extraHeaders: "HENT_AI_VERIFIER_EXTRA_HEADERS_JSON",
  extraBody: "HENT_AI_VERIFIER_EXTRA_BODY_JSON",
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseJsonObjectText(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim() ?? trimmed;
  try {
    return asRecord(JSON.parse(fenced));
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return asRecord(JSON.parse(fenced.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}

function extractChatCompletionsContent(record: Record<string, unknown>): string | null {
  const choices = Array.isArray(record.choices) ? record.choices : null;
  const firstChoice = asRecord(choices?.[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content ?? firstChoice?.text ?? record.content;
  if (typeof content === "string") return content;

  const contentBlocks = Array.isArray(content) ? content : Array.isArray(record.content) ? record.content : null;
  if (!contentBlocks) return null;
  const text = contentBlocks
    .map((block) => {
      if (typeof block === "string") return block;
      const blockRecord = asRecord(block);
      return typeof blockRecord?.text === "string" ? blockRecord.text : "";
    })
    .join("");
  return text.trim() || null;
}

export function normalizeVerifierJudgment(value: unknown): VerifierJudgment | null {
  const record = asRecord(value);
  if (!record) return null;

  const content = extractChatCompletionsContent(record);
  if (content) {
    const parsedContent = parseJsonObjectText(content);
    const parsedJudgment = parsedContent ? normalizeVerifierJudgment(parsedContent) : null;
    if (parsedJudgment) return parsedJudgment;
  }

  const nested = asRecord(record.verdict) ?? asRecord(record.judgment) ?? record;
  const emotion = typeof nested.emotion === "string" && nested.emotion.trim()
    ? nested.emotion.trim().toLowerCase()
    : undefined;
  if (!emotion) return null;

  const judgment: VerifierJudgment = { emotion };
  if (typeof nested.confidence === "number" && Number.isFinite(nested.confidence)) judgment.confidence = nested.confidence;
  if (typeof nested.reason === "string" && nested.reason.trim()) judgment.reason = nested.reason.trim();
  return judgment;
}

function parseJsonRecord(value: string | undefined, envKey: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  const record = asRecord(parsed);
  if (!record || Array.isArray(parsed)) throw new Error(`${envKey} must be a JSON object`);
  return record;
}

function requireString(value: string | undefined, envKey: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Missing ${envKey}`);
  return normalized;
}

function requirePositiveTimeout(value: string | undefined, envKey: string): number {
  const timeoutMs = value ? Number(value) : DEFAULT_VERIFIER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`${envKey} must be a positive integer`);
  return timeoutMs;
}

function normalizeHeaderMap(value: Record<string, unknown> | undefined, envKey: string): Record<string, string> | undefined {
  if (!value) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error(`${envKey} contains an empty header name`);
    if (typeof headerValue !== "string") throw new Error(`${envKey}.${normalizedName} must be a string`);
    headers[normalizedName] = headerValue;
  }
  return headers;
}

function normalizeBodyMapping(mapping: ChatCompletionsVerifierBodyMapping | undefined): Required<ChatCompletionsVerifierBodyMapping> {
  return { ...DEFAULT_BODY_MAPPING, ...mapping };
}

function normalizeVerifierProviderKind(providerKind: string): "openai-chat-completions" {
  if (providerKind === "openai-chat-completions" || providerKind === "vm4-closedrouter") {
    return "openai-chat-completions";
  }
  throw new Error(`Unsupported ${ENV_KEYS.providerKind}`);
}

function assertOpenAiChatCompletionsConfig(config: OpenAiChatCompletionsVerifierConfig): void {
  if (config.providerKind !== "openai-chat-completions") throw new Error("Unsupported verifier provider kind");
  if (!config.token.trim()) throw new Error("Missing HENT_AI_VERIFIER_TOKEN");
  if (!config.modelOrRoute.trim()) throw new Error("Missing HENT_AI_VERIFIER_MODEL_OR_ROUTE");
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("HENT_AI_VERIFIER_TIMEOUT_MS must be a positive integer");
  new URL(config.endpoint.toString());
  normalizeHeaderMap(config.extraHeaders, "extraHeaders");
}

export function loadVerifierProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VerifierProviderConfig {
  const providerKind = normalizeVerifierProviderKind((env[ENV_KEYS.providerKind] ?? "openai-chat-completions").trim());
  const extraHeaders = normalizeHeaderMap(parseJsonRecord(env[ENV_KEYS.extraHeaders], ENV_KEYS.extraHeaders), ENV_KEYS.extraHeaders);
  return {
    providerKind,
    endpoint: requireString(env[ENV_KEYS.endpoint], ENV_KEYS.endpoint),
    token: requireString(env[ENV_KEYS.token], ENV_KEYS.token),
    modelOrRoute: requireString(env[ENV_KEYS.modelOrRoute], ENV_KEYS.modelOrRoute),
    timeoutMs: requirePositiveTimeout(env[ENV_KEYS.timeoutMs], ENV_KEYS.timeoutMs),
    extraHeaders,
    extraBody: parseJsonRecord(env[ENV_KEYS.extraBody], ENV_KEYS.extraBody),
  };
}

function chatCompletionsBody(config: OpenAiChatCompletionsVerifierConfig, request: VerifierRequest): Record<string, unknown> {
  if (config.bodyMapping) {
    const mapping = normalizeBodyMapping(config.bodyMapping);
    return {
      ...(config.extraBody ?? {}),
      [mapping.modelOrRouteField]: config.modelOrRoute,
      [mapping.requestField]: {
        [mapping.finalTextField]: request.finalText,
        [mapping.validEmotionsField]: request.validEmotions,
        [mapping.channelIdField]: request.channelId,
        [mapping.metadataField]: request.metadata,
      },
    };
  }

  return {
    model: config.modelOrRoute,
    messages: [
      {
        role: "system",
        content: [
          "You classify a bot final response for Hent-ai.",
          "Return only JSON with keys: emotion, confidence, reason.",
          "emotion must be one of the provided validEmotions. If none fits, return null.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          finalText: request.finalText,
          validEmotions: request.validEmotions,
          channelId: request.channelId,
          metadata: request.metadata,
        }),
      },
    ],
    ...(config.extraBody ?? {}),
  };
}

export function createOpenAiChatCompletionsFinalResponseVerifier(config: OpenAiChatCompletionsVerifierConfig): FinalResponseVerifier {
  assertOpenAiChatCompletionsConfig(config);
  const endpoint = new URL(config.endpoint.toString());
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  return {
    async verify(request) {
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
          body: JSON.stringify(chatCompletionsBody(config, request)),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Verifier returned HTTP ${response.status}`);
        return normalizeVerifierJudgment(await response.json());
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createFinalResponseVerifierFromConfig(config: VerifierProviderConfig): FinalResponseVerifier {
  if (config.providerKind === "openai-chat-completions") return createOpenAiChatCompletionsFinalResponseVerifier(config);
  throw new Error("Unsupported verifier provider kind");
}

export function createRemoteFinalResponseVerifier(options: RemoteFinalResponseVerifierOptions): FinalResponseVerifier {
  const endpoint = new URL(options.url.toString());
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async verify(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify({
            context: {
              channelId: request.channelId,
              content: request.finalText,
              validEmotions: request.validEmotions,
              metadata: request.metadata,
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Verifier returned HTTP ${response.status}`);
        return normalizeVerifierJudgment(await response.json());
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
