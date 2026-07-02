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
  readonly recentTurnWindow: number;
  readonly contextRefreshEnabled: boolean;
  readonly compactionIntervalMs: number;
  readonly defaultChannelEnabled: boolean;
  readonly basePauseMs: number;
  readonly perCharMs: number;
  readonly maxDeliveryAttempts: number;
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
  maxChunks: "HENT_AI_CONVERSATION_MAX_CHUNKS",
  maxChunkChars: "HENT_AI_CONVERSATION_MAX_CHUNK_CHARS",
  cooldownMs: "HENT_AI_CONVERSATION_COOLDOWN_MS",
  budgetPerHour: "HENT_AI_CONVERSATION_BUDGET_PER_HOUR",
  minHumanIdleMs: "HENT_AI_CONVERSATION_MIN_HUMAN_IDLE_MS",
  confidenceThreshold: "HENT_AI_CONVERSATION_CONFIDENCE_THRESHOLD",
  persona: "HENT_AI_CONVERSATION_PERSONA",
  recentTurnWindow: "HENT_AI_CONVERSATION_RECENT_TURNS",
  contextRefreshEnabled: "HENT_AI_CONVERSATION_CONTEXT_REFRESH",
  compactionIntervalMs: "HENT_AI_CONVERSATION_COMPACTION_INTERVAL_MS",
  defaultChannelEnabled: "HENT_AI_CONVERSATION_DEFAULT_CHANNEL_ENABLED",
  basePauseMs: "HENT_AI_CONVERSATION_BASE_PAUSE_MS",
  perCharMs: "HENT_AI_CONVERSATION_PER_CHAR_MS",
  maxDeliveryAttempts: "HENT_AI_CONVERSATION_MAX_DELIVERY_ATTEMPTS",
} as const;

export const DEFAULT_CONVERSATION_CONFIG: ConversationServiceConfig = {
  enabled: false,
  rawRetentionDays: 14,
  minDelayMs: 650,
  maxDelayMs: 6500,
  maxChunks: 5,
  maxChunkChars: 140,
  cooldownMs: 600_000,
  budgetPerHour: 20,
  minHumanIdleMs: 12_000,
  confidenceThreshold: 0.7,
  recentTurnWindow: 24,
  contextRefreshEnabled: true,
  compactionIntervalMs: 21_600_000,
  defaultChannelEnabled: true,
  basePauseMs: 400,
  perCharMs: 55,
  maxDeliveryAttempts: 3,
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

function parseConfidenceEnv(value: string | undefined, envKey: string, fallback: number): { readonly value: number; readonly diagnostic?: string } {
  const normalized = value?.trim();
  if (!normalized) return { value: fallback };
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return { value: fallback, diagnostic: `${envKey} must be a number between 0 and 1` };
  }
  return { value: parsed };
}

function parseOptionalTextEnv(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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

  const maxChunks = parsePositiveIntegerEnv(env[ENV_KEYS.maxChunks], ENV_KEYS.maxChunks, DEFAULT_CONVERSATION_CONFIG.maxChunks);
  if (maxChunks.diagnostic) diagnostics.push(maxChunks.diagnostic);

  const maxChunkChars = parsePositiveIntegerEnv(env[ENV_KEYS.maxChunkChars], ENV_KEYS.maxChunkChars, DEFAULT_CONVERSATION_CONFIG.maxChunkChars);
  if (maxChunkChars.diagnostic) diagnostics.push(maxChunkChars.diagnostic);

  const cooldownMs = parseNonNegativeIntegerEnv(env[ENV_KEYS.cooldownMs], ENV_KEYS.cooldownMs, DEFAULT_CONVERSATION_CONFIG.cooldownMs);
  if (cooldownMs.diagnostic) diagnostics.push(cooldownMs.diagnostic);

  const budgetPerHour = parsePositiveIntegerEnv(env[ENV_KEYS.budgetPerHour], ENV_KEYS.budgetPerHour, DEFAULT_CONVERSATION_CONFIG.budgetPerHour);
  if (budgetPerHour.diagnostic) diagnostics.push(budgetPerHour.diagnostic);

  const minHumanIdleMs = parseNonNegativeIntegerEnv(env[ENV_KEYS.minHumanIdleMs], ENV_KEYS.minHumanIdleMs, DEFAULT_CONVERSATION_CONFIG.minHumanIdleMs);
  if (minHumanIdleMs.diagnostic) diagnostics.push(minHumanIdleMs.diagnostic);

  const confidenceThreshold = parseConfidenceEnv(
    env[ENV_KEYS.confidenceThreshold],
    ENV_KEYS.confidenceThreshold,
    DEFAULT_CONVERSATION_CONFIG.confidenceThreshold,
  );
  if (confidenceThreshold.diagnostic) diagnostics.push(confidenceThreshold.diagnostic);

  const recentTurnWindow = parsePositiveIntegerEnv(
    env[ENV_KEYS.recentTurnWindow],
    ENV_KEYS.recentTurnWindow,
    DEFAULT_CONVERSATION_CONFIG.recentTurnWindow,
  );
  if (recentTurnWindow.diagnostic) diagnostics.push(recentTurnWindow.diagnostic);

  const contextRefreshEnabled = parseBooleanEnv(
    env[ENV_KEYS.contextRefreshEnabled],
    ENV_KEYS.contextRefreshEnabled,
    DEFAULT_CONVERSATION_CONFIG.contextRefreshEnabled,
  );
  if (contextRefreshEnabled.kind === "invalid") diagnostics.push(contextRefreshEnabled.diagnostic);

  const compactionIntervalMs = parsePositiveIntegerEnv(
    env[ENV_KEYS.compactionIntervalMs],
    ENV_KEYS.compactionIntervalMs,
    DEFAULT_CONVERSATION_CONFIG.compactionIntervalMs,
  );
  if (compactionIntervalMs.diagnostic) diagnostics.push(compactionIntervalMs.diagnostic);

  const defaultChannelEnabled = parseBooleanEnv(
    env[ENV_KEYS.defaultChannelEnabled],
    ENV_KEYS.defaultChannelEnabled,
    DEFAULT_CONVERSATION_CONFIG.defaultChannelEnabled,
  );
  if (defaultChannelEnabled.kind === "invalid") diagnostics.push(defaultChannelEnabled.diagnostic);

  const basePauseMs = parseNonNegativeIntegerEnv(env[ENV_KEYS.basePauseMs], ENV_KEYS.basePauseMs, DEFAULT_CONVERSATION_CONFIG.basePauseMs);
  if (basePauseMs.diagnostic) diagnostics.push(basePauseMs.diagnostic);

  const perCharMs = parseNonNegativeIntegerEnv(env[ENV_KEYS.perCharMs], ENV_KEYS.perCharMs, DEFAULT_CONVERSATION_CONFIG.perCharMs);
  if (perCharMs.diagnostic) diagnostics.push(perCharMs.diagnostic);

  const maxDeliveryAttempts = parsePositiveIntegerEnv(
    env[ENV_KEYS.maxDeliveryAttempts],
    ENV_KEYS.maxDeliveryAttempts,
    DEFAULT_CONVERSATION_CONFIG.maxDeliveryAttempts,
  );
  if (maxDeliveryAttempts.diagnostic) diagnostics.push(maxDeliveryAttempts.diagnostic);

  return {
    ...DEFAULT_CONVERSATION_CONFIG,
    enabled: enabled.kind === "valid" && diagnostics.length === 0 ? enabled.value : false,
    rawRetentionDays: rawRetentionDays.value,
    minDelayMs: minDelayMs.value,
    maxDelayMs: maxDelayMs.value,
    maxChunks: maxChunks.value,
    maxChunkChars: maxChunkChars.value,
    cooldownMs: cooldownMs.value,
    budgetPerHour: budgetPerHour.value,
    minHumanIdleMs: minHumanIdleMs.value,
    confidenceThreshold: confidenceThreshold.value,
    recentTurnWindow: recentTurnWindow.value,
    contextRefreshEnabled: contextRefreshEnabled.kind === "valid" ? contextRefreshEnabled.value : DEFAULT_CONVERSATION_CONFIG.contextRefreshEnabled,
    compactionIntervalMs: compactionIntervalMs.value,
    defaultChannelEnabled: defaultChannelEnabled.kind === "valid" ? defaultChannelEnabled.value : DEFAULT_CONVERSATION_CONFIG.defaultChannelEnabled,
    basePauseMs: basePauseMs.value,
    perCharMs: perCharMs.value,
    maxDeliveryAttempts: maxDeliveryAttempts.value,
    ...(parseOptionalTextEnv(env[ENV_KEYS.persona]) ? { persona: parseOptionalTextEnv(env[ENV_KEYS.persona]) } : {}),
    diagnostics,
  };
}
