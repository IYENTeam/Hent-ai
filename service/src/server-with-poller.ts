import type { Server } from "node:http";
import { createConversationRuntime, type ConversationRuntime } from "./conversation-runtime.js";
import { loadConversationConfigFromEnv, type ConversationServiceConfig } from "./conversation-config.js";
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
  const conversationRuntime = options.conversationRuntime ?? createConversationRuntime(
    options.db,
    options.conversationConfig ?? loadConversationConfigFromEnv(),
  );
  const server = createHentAiServer(options);
  const pollerConfig = options.discordPollerConfig === undefined
    ? loadDiscordPollerConfigFromEnv()
    : options.discordPollerConfig;
  if (!pollerConfig) return { server };

  const integration = createDiscordPollerIntegration({
    config: { ...pollerConfig, autoStart: pollerConfig.autoStart ?? true },
    runtime: conversationRuntime,
    client: options.discordPollerClient,
    log: options.discordPollerLog ?? defaultDiscordPollerLog,
  });
  return { server, startPoller: integration.start, stopPoller: integration.stop };
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
