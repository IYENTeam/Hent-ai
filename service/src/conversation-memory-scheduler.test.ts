import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG } from "./conversation-config.js";
import { CONVERSATION_CONTRACT_SCHEMAS } from "./conversation-contracts.js";
import { createMemoryCompactionScheduler } from "./conversation-memory-scheduler.js";
import type { ConversationProviderClient } from "./conversation-provider-client.js";
import { createConversationStore } from "./conversation-store.js";
import { ServiceDatabase } from "./db.js";

describe("conversation memory scheduler", () => {
  it("compacts old raw rows through the shared provider client and prevents re-entrant runs", async () => {
    // Given: old raw rows and a slow provider-backed scheduler.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    store.recordRawEvent({
      scopeId: "discord:c1",
      channelId: "c1",
      messageId: "old-1",
      authorRole: "user",
      authorSource: "openclaw",
      text: "Mira prefers morning deploys.",
      eventTs: "2026-06-01T00:00:00.000Z",
    });
    let resolveProvider: (value: string) => void = () => {
      throw new Error("provider promise was not created");
    };
    const client: ConversationProviderClient = {
      complete: vi.fn(async () => new Promise<string>((resolve) => {
        resolveProvider = resolve;
      })),
    };
    const scheduler = createMemoryCompactionScheduler({
      store,
      client,
      config: DEFAULT_CONVERSATION_CONFIG,
      intervalMs: 21_600_000,
      model: "memory-model",
      now: () => "2026-07-02T00:00:00.000Z",
      log: () => {},
    });

    // When: two compaction runs overlap.
    const firstRun = scheduler.compactOnce();
    const secondRun = scheduler.compactOnce();
    resolveProvider(JSON.stringify({
      schema: CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction,
      scopeId: "discord:c1",
      sourceMessageIds: ["old-1"],
      summary: "Mira prefers morning deploys.",
      durableFacts: ["Mira prefers morning deploys."],
      confidence: 0.93,
    }));
    const results = await Promise.all([firstRun, secondRun]);

    // Then: only one provider call executes and the second run reports a skipped overlap.
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ compactedScopeCount: 1, summaryCount: 1, prunedRawCount: 1 });
    expect(results[1]).toMatchObject({ skipped: true, reason: "already_running" });
    expect(store.listSummaries("discord:c1")).toMatchObject([{ summary: "Mira prefers morning deploys." }]);
    db.close();
  });
});
