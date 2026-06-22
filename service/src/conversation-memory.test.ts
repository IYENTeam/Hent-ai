import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG } from "./conversation-config.js";
import { CONVERSATION_CONTRACT_SCHEMAS } from "./conversation-contracts.js";
import { compactConversationMemory, type ConversationMemoryCompactionProvider } from "./conversation-memory.js";
import { createConversationStore } from "./conversation-store.js";
import { ServiceDatabase } from "./db.js";

function recordTurn(
  store: ReturnType<typeof createConversationStore>,
  messageId: string,
  text: string,
  eventTs: string,
  authorRole: "user" | "assistant" = "user",
): void {
  store.recordRawEvent({
    scopeId: "channel:c1:session:s1",
    channelId: "c1",
    sessionId: "s1",
    messageId,
    authorRole,
    authorSource: "openclaw",
    text,
    eventTs,
    observedAt: eventTs,
  });
}

describe("conversation memory compaction", () => {
  it("compacts retained raw history into a durable summary before pruning old rows", async () => {
    // Given: raw room events older than the default retention window and a newer event.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    recordTurn(store, "m-old-1", "We should remember Mira prefers morning deploys.", "2026-06-01T09:00:00.000Z");
    recordTurn(store, "m-old-2", "The bot agreed to avoid Friday launches.", "2026-06-01T09:01:00.000Z", "assistant");
    recordTurn(store, "m-new", "Today we are checking rollout status.", "2026-06-21T09:00:00.000Z");
    const provider: ConversationMemoryCompactionProvider = {
      compact: async () => JSON.stringify({
        schema: CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction,
        scopeId: "channel:c1:session:s1",
        sourceMessageIds: ["m-old-1", "m-old-2"],
        summary: "Mira prefers morning deploys, and the room avoids Friday launches.",
        durableFacts: ["Mira prefers morning deploys.", "The room avoids Friday launches."],
        confidence: 0.93,
      }),
    };

    // When: memory compaction runs at a deterministic now.
    const result = await compactConversationMemory({
      store,
      provider,
      config: DEFAULT_CONVERSATION_CONFIG,
      now: "2026-06-22T00:00:00.000Z",
    });

    // Then: old raw rows are deleted only after their summary is durable.
    expect(result).toMatchObject({
      compactedScopeCount: 1,
      summaryCount: 1,
      prunedRawCount: 2,
      diagnostics: [],
    });
    expect(store.listRawEvents("channel:c1:session:s1")).toMatchObject([{ messageId: "m-new" }]);
    expect(store.listSummaries("channel:c1:session:s1")).toMatchObject([
      {
        summary: "Mira prefers morning deploys, and the room avoids Friday launches.",
        sourceEventStartId: 1,
        sourceEventEndId: 2,
      },
    ]);
    db.close();
  });

  it("keeps summaries indefinitely when raw retention cleanup deletes older rows", async () => {
    // Given: an existing long-term summary and raw events past a one-day retention window.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    recordTurn(store, "m-old", "Past room context.", "2026-06-18T09:00:00.000Z");
    const existingSummary = store.addSummary({
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      summary: "Existing durable memory must survive cleanup.",
      sourceEventStartId: 99,
      sourceEventEndId: 101,
      createdAt: "2026-06-18T10:00:00.000Z",
    });
    const provider: ConversationMemoryCompactionProvider = {
      compact: async () => JSON.stringify({
        schema: CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction,
        scopeId: "channel:c1:session:s1",
        sourceMessageIds: ["m-old"],
        summary: "Past room context was compacted.",
        durableFacts: ["Past room context exists."],
        confidence: 0.9,
      }),
    };

    // When: compaction runs with a narrower retention window.
    const result = await compactConversationMemory({
      store,
      provider,
      config: { ...DEFAULT_CONVERSATION_CONFIG, rawRetentionDays: 1 },
      now: "2026-06-22T00:00:00.000Z",
    });

    // Then: raw rows are pruned, while old and new summaries remain readable.
    expect(result.prunedRawCount).toBe(1);
    expect(store.listRawEvents("channel:c1:session:s1")).toEqual([]);
    expect(store.listSummaries("channel:c1:session:s1")).toMatchObject([
      { id: existingSummary.id, summary: "Existing durable memory must survive cleanup." },
      { summary: "Past room context was compacted." },
    ]);
    db.close();
  });

  it("leaves raw rows intact and records a retryable diagnostic when provider output is invalid", async () => {
    // Given: old raw rows and a provider that returns malformed memory JSON.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    recordTurn(store, "m-old", "This row must be retried later.", "2026-06-01T09:00:00.000Z");
    store.addSummary({
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      summary: "Existing durable memory survives provider failure.",
      sourceEventStartId: 7,
      sourceEventEndId: 8,
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    const provider: ConversationMemoryCompactionProvider = {
      compact: async () => "{\"schema\":\"wrong\"}",
    };

    // When: memory compaction attempts to process the old row.
    const result = await compactConversationMemory({
      store,
      provider,
      config: DEFAULT_CONVERSATION_CONFIG,
      now: "2026-06-22T00:00:00.000Z",
    });

    // Then: no raw rows or summaries are deleted, and the failure is retryable.
    expect(result).toMatchObject({
      compactedScopeCount: 0,
      summaryCount: 0,
      prunedRawCount: 0,
      diagnostics: [
        {
          scopeId: "channel:c1:session:s1",
          code: "invalid_field",
          retryable: true,
        },
      ],
    });
    expect(store.listRawEvents("channel:c1:session:s1")).toMatchObject([{ messageId: "m-old" }]);
    expect(store.listSummaries("channel:c1:session:s1")).toMatchObject([
      { summary: "Existing durable memory survives provider failure." },
    ]);
    db.close();
  });

  it("leaves raw rows and summaries intact when the provider throws", async () => {
    // Given: old raw rows, an existing summary, and a provider that throws before returning compaction text.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    recordTurn(store, "m-old", "This row must stay queued for retry.", "2026-06-01T09:00:00.000Z");
    store.addSummary({
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      summary: "Existing durable memory survives provider exceptions.",
      sourceEventStartId: 11,
      sourceEventEndId: 12,
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    const provider: ConversationMemoryCompactionProvider = {
      compact: async () => {
        throw new Error("provider connection reset");
      },
    };

    // When: memory compaction attempts to process the old row.
    const result = await compactConversationMemory({
      store,
      provider,
      config: DEFAULT_CONVERSATION_CONFIG,
      now: "2026-06-22T00:00:00.000Z",
    });

    // Then: the failure is retryable and no raw rows or summaries are deleted.
    expect(result).toMatchObject({
      compactedScopeCount: 0,
      summaryCount: 0,
      prunedRawCount: 0,
      diagnostics: [
        {
          scopeId: "channel:c1:session:s1",
          code: "provider_error",
          message: "provider connection reset",
          retryable: true,
        },
      ],
    });
    expect(store.listRawEvents("channel:c1:session:s1")).toMatchObject([{ messageId: "m-old" }]);
    expect(store.listSummaries("channel:c1:session:s1")).toMatchObject([
      { summary: "Existing durable memory survives provider exceptions." },
    ]);
    db.close();
  });
});
