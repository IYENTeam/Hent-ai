export type ConversationServiceConfig = {
  readonly enabled: boolean;
  readonly rawRetentionDays: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxChunks: number;
  readonly maxChunkChars: number;
  readonly cooldownMs: number;
  readonly budgetPerHour: number;
  readonly minHumanIdleMs: number;
  readonly confidenceThreshold: number;
  readonly persona?: string;
  readonly diagnostics: readonly string[];
};

export type ConversationScope = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly sessionId?: string;
};

export type ConversationTurnAuthor = "user" | "assistant";

export type ConversationTurn = ConversationScope & {
  readonly author: ConversationTurnAuthor;
  readonly content: string;
  readonly observedAtMs: number;
};

export type ConversationProviderDiagnostic = {
  readonly code: string;
  readonly message: string;
};

export type ConversationProviderDecision =
  | { readonly kind: "no_reply"; readonly reason: string; readonly diagnostics?: readonly ConversationProviderDiagnostic[] }
  | { readonly kind: "speak"; readonly confidence: number; readonly chunks: readonly string[]; readonly diagnostics?: readonly ConversationProviderDiagnostic[] };

export type ConversationDecisionRequest = {
  readonly config: ConversationServiceConfig;
  readonly scope: ConversationScope;
  readonly recentTurns: readonly ConversationTurn[];
  readonly memorySummaries: readonly string[];
};

export interface ConversationDecisionProvider {
  readonly decide: (request: ConversationDecisionRequest) => Promise<ConversationProviderDecision>;
}

type EnvMap = Readonly<Record<string, string | undefined>>;

type BooleanParseResult =
  | { readonly kind: "valid"; readonly value: boolean }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const ENV_KEYS = {
  enabled: "HENT_AI_CONVERSATION_ENABLED",
  rawRetentionDays: "HENT_AI_CONVERSATION_RAW_RETENTION_DAYS",
  minDelayMs: "HENT_AI_CONVERSATION_MIN_DELAY_MS",
  maxDelayMs: "HENT_AI_CONVERSATION_MAX_DELAY_MS",
} as const;

export const DEFAULT_CONVERSATION_CONFIG: ConversationServiceConfig = {
  enabled: false,
  rawRetentionDays: 14,
  minDelayMs: 650,
  maxDelayMs: 6500,
  maxChunks: 4,
  maxChunkChars: 1800,
  cooldownMs: 600_000,
  budgetPerHour: 20,
  minHumanIdleMs: 12_000,
  confidenceThreshold: 0.7,
  diagnostics: [],
};

function parseBooleanEnv(value: string | undefined, envKey: string, fallback: boolean): BooleanParseResult {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case undefined:
    case "":
      return { kind: "valid", value: fallback };
    case "1":
    case "true":
    case "yes":
    case "on":
      return { kind: "valid", value: true };
    case "0":
    case "false":
    case "no":
    case "off":
      return { kind: "valid", value: false };
    default:
      return { kind: "invalid", diagnostic: `${envKey} must be one of true,false,1,0,yes,no,on,off` };
  }
}

function parsePositiveIntegerEnv(value: string | undefined, envKey: string, fallback: number): { readonly value: number; readonly diagnostic?: string } {
  const normalized = value?.trim();
  if (!normalized) return { value: fallback };
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { value: fallback, diagnostic: `${envKey} must be a positive integer` };
  }
  return { value: parsed };
}

function parseNonNegativeIntegerEnv(value: string | undefined, envKey: string, fallback: number): { readonly value: number; readonly diagnostic?: string } {
  const normalized = value?.trim();
  if (!normalized) return { value: fallback };
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { value: fallback, diagnostic: `${envKey} must be a non-negative integer` };
  }
  return { value: parsed };
}

export function loadConversationConfigFromEnv(env: EnvMap = process.env): ConversationServiceConfig {
  const diagnostics: string[] = [];
  const enabled = parseBooleanEnv(env[ENV_KEYS.enabled], ENV_KEYS.enabled, DEFAULT_CONVERSATION_CONFIG.enabled);
  if (enabled.kind === "invalid") diagnostics.push(enabled.diagnostic);

  const rawRetentionDays = parsePositiveIntegerEnv(
    env[ENV_KEYS.rawRetentionDays],
    ENV_KEYS.rawRetentionDays,
    DEFAULT_CONVERSATION_CONFIG.rawRetentionDays,
  );
  if (rawRetentionDays.diagnostic) diagnostics.push(rawRetentionDays.diagnostic);

  const minDelayMs = parseNonNegativeIntegerEnv(env[ENV_KEYS.minDelayMs], ENV_KEYS.minDelayMs, DEFAULT_CONVERSATION_CONFIG.minDelayMs);
  if (minDelayMs.diagnostic) diagnostics.push(minDelayMs.diagnostic);

  const maxDelayMs = parseNonNegativeIntegerEnv(env[ENV_KEYS.maxDelayMs], ENV_KEYS.maxDelayMs, DEFAULT_CONVERSATION_CONFIG.maxDelayMs);
  if (maxDelayMs.diagnostic) diagnostics.push(maxDelayMs.diagnostic);
  if (maxDelayMs.value < minDelayMs.value) {
    diagnostics.push(`${ENV_KEYS.maxDelayMs} must be greater than or equal to ${ENV_KEYS.minDelayMs}`);
  }

  return {
    ...DEFAULT_CONVERSATION_CONFIG,
    enabled: enabled.kind === "valid" && diagnostics.length === 0 ? enabled.value : false,
    rawRetentionDays: rawRetentionDays.value,
    minDelayMs: minDelayMs.value,
    maxDelayMs: maxDelayMs.value,
    diagnostics,
  };
}
