import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { loadConversationConfigFromEnv, type ConversationServiceConfig } from "./conversation-config.js";
import { createConversationProviderClient, loadConversationProviderConfigFromEnv } from "./conversation-provider-client.js";
import { ServiceDatabase } from "./db.js";
import { createHentAiServerWithPoller } from "./server-with-poller.js";
import {
  createFinalResponseVerifierFromConfig,
  loadVerifierProviderConfigFromEnv,
  type FinalResponseVerifier,
} from "./verifier.js";
import { loadDiscordPollerConfigFromEnv, type DiscordPollerIntegrationConfig, type DiscordPollerLog } from "./discord-poller-integration.js";

export type StartupDiagnostic = {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
};

export type StartupDiagnosticsInput = {
  readonly conversationConfig: ConversationServiceConfig;
  readonly pollerConfig: DiscordPollerIntegrationConfig | null;
  readonly providerConfigured: boolean;
  readonly verifierConfigured: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
};

export type MainLogger = {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
};

const nullVerifier: FinalResponseVerifier = { verify: async () => null };

export function startupDiagnostics(input: StartupDiagnosticsInput): readonly StartupDiagnostic[] {
  const diagnostics: StartupDiagnostic[] = [];
  for (const diagnostic of input.conversationConfig.diagnostics) {
    diagnostics.push({ level: "error", message: `${diagnostic}; conversation disabled` });
  }
  if (!input.conversationConfig.enabled) {
    diagnostics.push({
      level: "warn",
      message: input.conversationConfig.diagnostics.length > 0 ? "conversation disabled due to invalid configuration" : "conversation disabled by env",
    });
  }
  if (!input.pollerConfig) {
    diagnostics.push({ level: "warn", message: `discord poller disabled: missing ${missingPollerEnv(input.env).join(", ")}` });
  }
  if (!textEnv(input.env.HENT_AI_DISCORD_POLLER_BOT_USER_ID)) {
    diagnostics.push({ level: "warn", message: "HENT_AI_DISCORD_POLLER_BOT_USER_ID missing; self-message recognition is disabled" });
  }
  if (!input.providerConfigured) {
    diagnostics.push({ level: "warn", message: "conversation provider missing; reply checks run as no_reply(missing_decision_provider)" });
  }
  if (!input.verifierConfigured) {
    diagnostics.push({ level: "warn", message: "final-response verifier missing; emotion verdict selection is disabled" });
  }
  return diagnostics;
}

export async function startHentAiService(
  env: NodeJS.ProcessEnv = process.env,
  logger: MainLogger = console,
): Promise<{ readonly server: Server; readonly close: () => Promise<void> }> {
  const db = new ServiceDatabase(textEnv(env.HENT_AI_DB_PATH) ?? "./hent-ai.sqlite");
  const conversationConfig = loadConversationConfigFromEnv(env);
  const pollerConfig = loadDiscordPollerConfigFromEnv(env);
  const providerConfig = loadConversationProviderConfigFromEnv(env);
  const providerClient = providerConfig ? createConversationProviderClient(providerConfig) : undefined;
  const verifier = loadVerifier(logger, env);
  for (const diagnostic of startupDiagnostics({
    conversationConfig,
    pollerConfig,
    providerConfigured: providerClient !== undefined,
    verifierConfigured: verifier !== nullVerifier,
    env,
  })) {
    logDiagnostic(logger, diagnostic);
  }
  const result = createHentAiServerWithPoller({
    db,
    token: env.HENT_AI_SERVICE_TOKEN ?? "",
    verifier,
    conversationConfig,
    ...(providerClient ? { conversationProviderClient: providerClient } : {}),
    conversationDecisionModel: textEnv(env.HENT_AI_CONVERSATION_DECISION_MODEL),
    conversationContextModel: textEnv(env.HENT_AI_CONVERSATION_CONTEXT_MODEL),
    conversationMemoryModel: textEnv(env.HENT_AI_CONVERSATION_MEMORY_MODEL),
    discordPollerConfig: pollerConfig,
    discordPollerLog: serviceDiscordLog(logger),
  });
  const host = textEnv(env.HENT_AI_HOST) ?? "127.0.0.1";
  const port = positiveIntegerEnv(env.HENT_AI_PORT, 8787);
  await new Promise<void>((resolveListen) => result.server.listen(port, host, resolveListen));
  result.startPoller?.();
  logger.info(`hent-ai-service listening host=${host} port=${port}`);
  return {
    server: result.server,
    close: async () => {
      await result.stopPoller?.();
      await new Promise<void>((resolveClose, reject) => result.server.close((error) => error ? reject(error) : resolveClose()));
      db.close();
    },
  };
}

function loadVerifier(logger: MainLogger, env: NodeJS.ProcessEnv): FinalResponseVerifier {
  try {
    return createFinalResponseVerifierFromConfig(loadVerifierProviderConfigFromEnv(env));
  } catch (error) {
    if (error instanceof Error) logger.warn(`final-response verifier disabled: ${error.message}`);
    else logger.warn("final-response verifier disabled: unknown configuration error");
    return nullVerifier;
  }
}

function missingPollerEnv(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const missing: string[] = [];
  const token = textEnv(env.HENT_AI_DISCORD_POLLER_TOKEN) ?? textEnv(env.DISCORD_BOT_TOKEN);
  if (!token) missing.push("HENT_AI_DISCORD_POLLER_TOKEN");
  if (!textEnv(env.HENT_AI_DISCORD_POLLER_CHANNELS)) missing.push("HENT_AI_DISCORD_POLLER_CHANNELS");
  return missing.length > 0 ? missing : ["unknown"];
}

function logDiagnostic(logger: MainLogger, diagnostic: StartupDiagnostic): void {
  switch (diagnostic.level) {
    case "info":
      logger.info(diagnostic.message);
      return;
    case "warn":
      logger.warn(diagnostic.message);
      return;
    case "error":
      logger.error(diagnostic.message);
      return;
    default:
      assertNeverDiagnosticLevel(diagnostic.level);
  }
}

function serviceDiscordLog(logger: MainLogger): DiscordPollerLog {
  return (level, message) => logDiagnostic(logger, { level, message });
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function textEnv(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function assertNeverDiagnosticLevel(value: never): never {
  throw new Error(`Unhandled startup diagnostic level: ${String(value)}`);
}

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentModulePath) {
  void startHentAiService().catch((error: unknown) => {
    if (error instanceof Error) console.error(error.message);
    else console.error("hent-ai-service failed with a non-error value");
    process.exitCode = 1;
  });
}
