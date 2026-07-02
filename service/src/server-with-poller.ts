import type { Server } from "node:http";
import { refreshConversationContext } from "./conversation-context-refresher.js";
import { createLlmConversationDecisionProvider } from "./conversation-decision-provider.js";
import { createMemoryCompactionScheduler, type MemoryCompactionScheduler } from "./conversation-memory-scheduler.js";
import { createConversationPersonaResolver } from "./conversation-persona.js";
import type { ConversationProviderClient } from "./conversation-provider-client.js";
import { createConversationRuntime, type ConversationRuntime } from "./conversation-runtime.js";
import { loadConversationConfigFromEnv, type ConversationDecisionProvider, type ConversationServiceConfig } from "./conversation-config.js";
import { createConversationStore } from "./conversation-store.js";
import type { ServiceDatabase } from "./db.js";
import type { FinalResponseVerifier } from "./verifier.js";
import { createHentAiServer } from "./server.js";
import {
  createDiscordPollerIntegration,
  loadDiscordPollerConfigFromEnv,
  type DiscordPollerIntegrationConfig,
  type DiscordPollerLog,
} from "./discord-poller-integration.js";
import type { DiscordRestClient } from "./discord-rest-poller.js";

export type HentAiServerWithPollerOptions = {
  readonly db: ServiceDatabase;
  readonly token: string;
  readonly assetRoot?: string;
  readonly verifier: FinalResponseVerifier;
  readonly conversationConfig?: ConversationServiceConfig;
  readonly conversationDecisionProvider?: ConversationDecisionProvider;
  readonly conversationProviderClient?: ConversationProviderClient;
  readonly conversationDecisionModel?: string;
  readonly conversationContextModel?: string;
  readonly conversationMemoryModel?: string;
  readonly conversationRuntime?: ConversationRuntime;
  readonly discordPollerConfig?: DiscordPollerIntegrationConfig | null;
  readonly discordPollerClient?: DiscordRestClient;
  readonly discordPollerLog?: DiscordPollerLog;
};

export type HentAiServerResult = {
  readonly server: Server;
  readonly startPoller?: () => void;
  readonly stopPoller?: () => Promise<void>;
};

export function createHentAiServerWithPoller(options: HentAiServerWithPollerOptions): HentAiServerResult {
  const conversationConfig = options.conversationConfig ?? loadConversationConfigFromEnv();
  const providerClient = options.conversationProviderClient;
  const store = createConversationStore(options.db);
  const decisionProvider = options.conversationDecisionProvider ?? (providerClient
    ? createLlmConversationDecisionProvider({
      client: providerClient,
      resolvePersonaFor: createConversationPersonaResolver(options.db, conversationConfig),
      model: options.conversationDecisionModel,
    })
    : undefined);
  const conversationRuntime = options.conversationRuntime ?? createConversationRuntime(
    options.db,
    conversationConfig,
    {
      ...(decisionProvider ? { decisionProvider } : {}),
      ...(providerClient
        ? {
          refreshContext: (scope) => refreshConversationContext({
            store,
            client: providerClient,
            config: conversationConfig,
            scope,
            model: options.conversationContextModel,
            now: new Date().toISOString(),
          }),
        }
        : {}),
    },
  );
  const server = createHentAiServer(options);
  const memoryScheduler = providerClient && conversationConfig.enabled
    ? createMemoryCompactionScheduler({
      store,
      client: providerClient,
      config: conversationConfig,
      intervalMs: conversationConfig.compactionIntervalMs,
      model: options.conversationMemoryModel,
      log: options.discordPollerLog ?? defaultDiscordPollerLog,
    })
    : null;
  const pollerConfig = options.discordPollerConfig === undefined
    ? loadDiscordPollerConfigFromEnv()
    : options.discordPollerConfig;
  if (!pollerConfig && !memoryScheduler) return { server };

  const integration = pollerConfig
    ? createDiscordPollerIntegration({
      config: { ...pollerConfig, autoStart: pollerConfig.autoStart ?? true },
      runtime: conversationRuntime,
      client: options.discordPollerClient,
      pollerStateStore: {
        getLastSeenMessageId: (channelId) => options.db.getDiscordPollerState(channelId)?.lastSeenMessageId ?? null,
        setLastSeenMessageId: (channelId, messageId) => options.db.setDiscordPollerState(channelId, messageId),
      },
      conversationConfig,
      log: options.discordPollerLog ?? defaultDiscordPollerLog,
    })
    : null;
  return {
    server,
    startPoller: () => {
      integration?.start();
      memoryScheduler?.start();
    },
    stopPoller: () => stopRuntimes(integration?.stop, memoryScheduler),
  };
}

async function stopRuntimes(
  stopPoller: (() => Promise<void>) | undefined,
  memoryScheduler: MemoryCompactionScheduler | null,
): Promise<void> {
  if (stopPoller) await stopPoller();
  if (memoryScheduler) await memoryScheduler.stop();
}

function defaultDiscordPollerLog(level: "info" | "warn" | "error", message: string): void {
  const line = `[hent-ai-service:discord-poller] ${message}`;
  switch (level) {
    case "info":
      console.info(line);
      return;
    case "warn":
      console.warn(line);
      return;
    case "error":
      console.error(line);
      return;
    default:
      assertNeverLogLevel(level);
  }
}

function assertNeverLogLevel(value: never): never {
  throw new Error(`Unhandled Discord poller log level: ${String(value)}`);
}
