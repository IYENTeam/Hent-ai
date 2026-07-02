import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG } from "./conversation-config.js";
import { CONVERSATION_CONTRACT_SCHEMAS } from "./conversation-contracts.js";
import { refreshConversationContext } from "./conversation-context-refresher.js";
import type { ConversationProviderClient } from "./conversation-provider-client.js";
import { createConversationStore } from "./conversation-store.js";
import { ServiceDatabase } from "./db.js";

function recordUserTurn(store: ReturnType<typeof createConversationStore>, messageId: string, text: string): void {
  store.recordRawEvent({
    scopeId: "discord:c1",
    channelId: "c1",
    messageId,
    authorRole: "user",
    authorSource: "openclaw",
    text,
    eventTs: `2026-07-02T00:00:0${messageId.slice(-1)}.000Z`,
  });
}

describe("conversation context refresher", () => {
  it("updates the checkpoint from short-term context provider output", async () => {
    // Given: fresh raw events and a provider that returns short-term room context.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    recordUserTurn(store, "m1", "오늘 배포 리스크 먼저 보자");
    recordUserTurn(store, "m2", "롤백 기준도 정해야 해");
    const requestedModels: string[] = [];
    const client: ConversationProviderClient = {
      complete: async (_prompt, opts) => {
        if (opts?.model) requestedModels.push(opts.model);
        return JSON.stringify({
          schema: CONVERSATION_CONTRACT_SCHEMAS.shortTermContext,
          scopeId: "discord:c1",
          sourceMessageIds: ["m1", "m2"],
          activeTopic: "deployment risk",
          recentIntent: "set rollback criteria",
          openQuestions: ["what is the rollback threshold?"],
          shouldRemember: ["room wants rollout safety first"],
          confidence: 0.88,
        });
      },
    };

    // When: the context refresher runs for the Discord scope.
    const result = await refreshConversationContext({
      store,
      client,
      config: { ...DEFAULT_CONVERSATION_CONFIG, recentTurnWindow: 24 },
      scope: { scopeId: "discord:c1", channelId: "c1" },
      model: "context-model",
      now: "2026-07-02T00:01:00.000Z",
    });

    // Then: the checkpoint stores rendered provider context for later speech prompts.
    expect(result).toMatchObject({ status: "updated", diagnostics: [] });
    expect(requestedModels).toEqual(["context-model"]);
    expect(store.getCheckpoint("discord:c1")).toMatchObject({
      summary: expect.stringContaining("deployment risk"),
      recentEventIds: [1, 2],
      updatedAt: "2026-07-02T00:01:00.000Z",
    });
    db.close();
  });

  it("uses the existing naive summary when provider output is invalid", async () => {
    // Given: raw events and an unusable provider response.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    recordUserTurn(store, "m1", "이 내용은 fallback으로라도 남아야 해");
    const client: ConversationProviderClient = {
      complete: async () => "not json",
    };

    // When: provider parsing fails.
    const result = await refreshConversationContext({
      store,
      client,
      config: DEFAULT_CONVERSATION_CONFIG,
      scope: { scopeId: "discord:c1", channelId: "c1" },
      now: "2026-07-02T00:01:00.000Z",
    });

    // Then: the checkpoint remains useful and the diagnostic is retryable.
    expect(result).toMatchObject({ status: "fallback", diagnostics: [{ code: "malformed_json" }] });
    expect(store.getCheckpoint("discord:c1")?.summary).toContain("fallback으로라도");
    db.close();
  });
});
