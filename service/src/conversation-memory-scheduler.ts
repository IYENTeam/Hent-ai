import type { ConversationServiceConfig } from "./conversation-config.js";
import { compactConversationMemory, type CompactConversationMemoryResult, type ConversationMemoryCompactionProvider } from "./conversation-memory.js";
import type { ConversationProviderClient } from "./conversation-provider-client.js";
import type { ConversationStore } from "./conversation-store.js";

export type MemorySchedulerLog = (level: "info" | "warn" | "error", message: string) => void;

export type MemoryCompactionSchedulerResult =
  | CompactConversationMemoryResult
  | { readonly skipped: true; readonly reason: "already_running" };

export type MemoryCompactionScheduler = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly compactOnce: () => Promise<MemoryCompactionSchedulerResult>;
};

export type CreateMemoryCompactionSchedulerInput = {
  readonly store: ConversationStore;
  readonly client: ConversationProviderClient;
  readonly config: ConversationServiceConfig;
  readonly intervalMs: number;
  readonly model?: string;
  readonly now?: () => string;
  readonly log?: MemorySchedulerLog;
};

export function createMemoryCompactionScheduler(input: CreateMemoryCompactionSchedulerInput): MemoryCompactionScheduler {
  const now = input.now ?? (() => new Date().toISOString());
  const log = input.log ?? (() => {});
  const provider: ConversationMemoryCompactionProvider = {
    compact: (request) => input.client.complete(request.prompt, input.model ? { model: input.model } : undefined),
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeRun: Promise<CompactConversationMemoryResult> | null = null;

  async function compactOnce(): Promise<MemoryCompactionSchedulerResult> {
    if (activeRun) return { skipped: true, reason: "already_running" };
    activeRun = compactConversationMemory({
      store: input.store,
      provider,
      config: input.config,
      now: now(),
    });
    try {
      const result = await activeRun;
      log("info", `conversation-memory: compacted scopes=${result.compactedScopeCount} summaries=${result.summaryCount} pruned=${result.prunedRawCount} diagnostics=${result.diagnostics.length}`);
      return result;
    } finally {
      activeRun = null;
    }
  }

  return {
    start() {
      if (timer) return;
      void compactOnce();
      timer = setInterval(() => void compactOnce(), input.intervalMs);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (activeRun) await activeRun;
    },
    compactOnce,
  };
}
