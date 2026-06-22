import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG, type ConversationServiceConfig } from "./conversation-config.js";
import { ServiceDatabase } from "./db.js";
import { enabledConversationConfig, request, withServer } from "./service-test-helpers.js";

type DeliveryChunkReadback = {
  readonly chunkId: string;
  readonly text: string;
  readonly delayMs: number;
  readonly metadata: {
    readonly hentAiConversationChunk: true;
    readonly planId: string;
    readonly chunkIndex: number;
    readonly chunkCount: number;
  };
};

type DeliveryPlanReadback = {
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly chunks: readonly DeliveryChunkReadback[];
  readonly commit: {
    readonly planId: string;
    readonly cooldownKey: string;
    readonly signalId: string;
    readonly requiredChunkIds: readonly string[];
  };
};

type EvaluateReadback = {
  readonly decision: "nudge" | "no_reply";
  readonly deliveryPlan?: DeliveryPlanReadback;
};

function deliveryConfig(overrides: Partial<ConversationServiceConfig> = {}): ConversationServiceConfig {
  return {
    ...DEFAULT_CONVERSATION_CONFIG,
    ...enabledConversationConfig,
    minDelayMs: 10,
    maxDelayMs: 20,
    maxChunkChars: 50,
    maxChunks: 4,
    ...overrides,
  };
}

async function createDeliveryPlan(baseUrl: string, scopeId: string): Promise<DeliveryPlanReadback> {
  await request(baseUrl, "/v1/watcher/evaluate", {
    method: "POST",
    body: JSON.stringify({ scopeId, channelId: "c1", text: "Repeat the same stale deployment plan with rollback risk", messageId: "a1" }),
  });
  const response = await request(baseUrl, "/v1/watcher/evaluate", {
    method: "POST",
    body: JSON.stringify({ scopeId, channelId: "c1", text: "Repeat the same stale deployment plan with rollback risk", messageId: "a2" }),
  });
  const body: unknown = await response.json();
  expect(response.status).toBe(200);
  expect(isEvaluateWithPlan(body)).toBe(true);
  if (!isEvaluateWithPlan(body)) throw new Error("expected evaluate response with a delivery plan");
  expect(body.decision).toBe("nudge");
  return body.deliveryPlan;
}

function isEvaluateWithPlan(value: unknown): value is EvaluateReadback & { readonly deliveryPlan: DeliveryPlanReadback } {
  return isRecord(value) && value.decision === "nudge" && isDeliveryPlan(value.deliveryPlan);
}

function isDeliveryPlan(value: unknown): value is DeliveryPlanReadback {
  if (!isRecord(value) || !Array.isArray(value.chunks) || !isRecord(value.commit)) return false;
  return typeof value.planId === "string"
    && typeof value.scopeId === "string"
    && typeof value.channelId === "string"
    && value.chunks.every((chunk) => isDeliveryChunk(chunk))
    && typeof value.commit.planId === "string"
    && typeof value.commit.cooldownKey === "string"
    && typeof value.commit.signalId === "string"
    && isStringArray(value.commit.requiredChunkIds);
}

function isDeliveryChunk(value: unknown): value is DeliveryChunkReadback {
  if (!isRecord(value) || !isRecord(value.metadata)) return false;
  return typeof value.chunkId === "string"
    && typeof value.text === "string"
    && typeof value.delayMs === "number"
    && value.metadata.hentAiConversationChunk === true
    && typeof value.metadata.planId === "string"
    && typeof value.metadata.chunkIndex === "number"
    && typeof value.metadata.chunkCount === "number";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("conversation delivery plan", () => {
  it("returns bounded chunk metadata and records only a planned ledger before host sends", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      // Given: a repeated bot turn that passes the watcher speech gate.
      const plan = await createDeliveryPlan(baseUrl, "delivery-plan-scope");

      // Then: evaluate returns the service-owned delivery plan schema.
      expect(plan).toMatchObject({
        planId: expect.stringMatching(/^watcher:delivery-plan-scope:/),
        scopeId: "delivery-plan-scope",
        channelId: "c1",
        commit: {
          planId: plan.planId,
          cooldownKey: "delivery-plan-scope:stale_expression_repeated",
          signalId: "sig-stale-a2",
        },
      });
      expect(plan.chunks.length).toBeGreaterThanOrEqual(1);
      expect(plan.chunks.length).toBeLessThanOrEqual(4);
      expect(plan.commit.requiredChunkIds).toEqual(plan.chunks.map((chunk) => chunk.chunkId));
      plan.chunks.forEach((chunk, index) => {
        expect(chunk.text.length).toBeGreaterThan(0);
        expect(chunk.text.length).toBeLessThanOrEqual(50);
        expect(chunk.delayMs).toBeGreaterThanOrEqual(10);
        expect(chunk.delayMs).toBeLessThanOrEqual(20);
        expect(chunk.metadata).toEqual({
          hentAiConversationChunk: true,
          planId: plan.planId,
          chunkIndex: index,
          chunkCount: plan.chunks.length,
        });
      });
      expect(db.db.prepare("SELECT status, delivery_message_ids_json, committed_at FROM conversation_delivery_ledger WHERE plan_id = ?").get(plan.planId)).toEqual({
        status: "planned",
        delivery_message_ids_json: "{}",
        committed_at: null,
      });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM conversation_gate_state").get()).toEqual({ count: 0 });
    }, { conversationConfig: deliveryConfig() });
  });
});

describe("conversation delivery commit rejects incomplete or conflicting delivery", () => {
  it("commits only after every required chunk has a host send id and handles retries", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      // Given: a planned delivery with multiple required chunks.
      const plan = await createDeliveryPlan(baseUrl, "delivery-commit-scope");
      const [firstChunkId, ...remainingChunkIds] = plan.commit.requiredChunkIds;
      expect(firstChunkId).toBeDefined();
      expect(remainingChunkIds.length).toBeGreaterThan(0);

      // When: OpenClaw reports only a partial host delivery.
      const partial = await request(baseUrl, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({
          planId: plan.planId,
          cooldownKey: plan.commit.cooldownKey,
          scopeId: plan.scopeId,
          signalId: plan.commit.signalId,
          deliveryMessageIds: { [firstChunkId]: "discord-1" },
        }),
      });

      // Then: the service rejects it as retryable without committing cooldown state.
      expect(partial.status).toBe(409);
      expect(await partial.json()).toMatchObject({
        ok: false,
        retryable: true,
        error: "missing_required_chunks",
        missingChunkIds: remainingChunkIds,
      });
      expect(db.db.prepare("SELECT status, delivery_message_ids_json FROM conversation_delivery_ledger WHERE plan_id = ?").get(plan.planId)).toEqual({
        status: "planned",
        delivery_message_ids_json: "{}",
      });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM conversation_gate_state").get()).toEqual({ count: 0 });

      // When: all required host send ids arrive, then the same commit is retried.
      const deliveryMessageIds = Object.fromEntries(plan.commit.requiredChunkIds.map((chunkId, index) => [chunkId, `discord-${index + 1}`]));
      const committed = await request(baseUrl, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({
          planId: plan.planId,
          cooldownKey: plan.commit.cooldownKey,
          scopeId: plan.scopeId,
          signalId: plan.commit.signalId,
          deliveryMessageIds,
        }),
      });
      const duplicate = await request(baseUrl, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({
          planId: plan.planId,
          cooldownKey: plan.commit.cooldownKey,
          scopeId: plan.scopeId,
          signalId: plan.commit.signalId,
          deliveryMessageIds,
        }),
      });

      // Then: the commit updates ledger/cooldown once and exact duplicate retries are idempotent.
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({ ok: true, status: "committed" });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ ok: true, status: "idempotent" });
      expect(db.db.prepare("SELECT status, delivery_message_ids_json FROM conversation_delivery_ledger WHERE plan_id = ?").get(plan.planId)).toEqual({
        status: "committed",
        delivery_message_ids_json: JSON.stringify(deliveryMessageIds),
      });
      expect(db.db.prepare("SELECT state_key, last_signal_id FROM conversation_gate_state WHERE scope_id = ?").get(plan.scopeId)).toEqual({
        state_key: plan.commit.cooldownKey,
        last_signal_id: plan.commit.signalId,
      });

      // When: a duplicate commit changes one delivered host id.
      const conflict = await request(baseUrl, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({
          planId: plan.planId,
          cooldownKey: plan.commit.cooldownKey,
          scopeId: plan.scopeId,
          signalId: plan.commit.signalId,
          deliveryMessageIds: { ...deliveryMessageIds, [firstChunkId]: "different-discord-id" },
        }),
      });

      // Then: conflicting duplicates are rejected with a non-retryable conflict.
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ ok: false, retryable: false, error: "conflict" });
    }, { conversationConfig: deliveryConfig({ maxChunkChars: 48 }) });
  });

  it("returns 400 for missing commit metadata without updating cooldown or ledger state", async () => {
    const db = new ServiceDatabase();
    await withServer(db, async (baseUrl) => {
      // Given: a delivery plan that has not been committed.
      const plan = await createDeliveryPlan(baseUrl, "delivery-bad-metadata-scope");

      // When: the commit request omits required delivery metadata.
      const badCommit = await request(baseUrl, "/v1/watcher/commit-delivery", {
        method: "POST",
        body: JSON.stringify({
          planId: plan.planId,
          cooldownKey: plan.commit.cooldownKey,
          scopeId: plan.scopeId,
          signalId: plan.commit.signalId,
        }),
      });

      // Then: the service rejects the shape and does not update ledger/cooldown state.
      expect(badCommit.status).toBe(400);
      expect(await badCommit.json()).toMatchObject({
        error: "bad_request",
        message: "planId, cooldownKey, scopeId, signalId, and deliveryMessageIds are required",
      });
      expect(db.db.prepare("SELECT status, delivery_message_ids_json FROM conversation_delivery_ledger WHERE plan_id = ?").get(plan.planId)).toEqual({
        status: "planned",
        delivery_message_ids_json: "{}",
      });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM conversation_gate_state").get()).toEqual({ count: 0 });
    }, { conversationConfig: deliveryConfig() });
  });
});
