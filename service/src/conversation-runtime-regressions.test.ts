import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceDatabase } from "./db.js";
import { ConversationRuntime } from "./conversation-runtime.js";
import { ConversationStore } from "./conversation-store.js";
import { DEFAULT_CONVERSATION_CONFIG } from "./conversation-config.js";
import { handleWatcherRoute } from "./watcher-routes.js";
import { DELIVERY_CLAIM_MS } from "./conversation-delivery-dispatch.js";

const config = { ...DEFAULT_CONVERSATION_CONFIG, enabled: true, minDelayMs: 0, maxDelayMs: 0, maxChunkChars: 50 };
const repeated = "Repeat the same stale deployment plan with rollback risk";
const input = (messageId: string, text = repeated) => ({ scopeId: "c1", channelId: "c1", messageId, text });
const databases: ServiceDatabase[] = [];
const roots: string[] = [];
function database(path?: string): ServiceDatabase { const db = new ServiceDatabase(path); databases.push(db); return db; }
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});

describe("watcher intake and replay", () => {
  it("preserves human roles on explicit intake and old-client evaluate replay", async () => {
    const db = database(); const runtime = new ConversationRuntime(db, config);
    for (const id of ["human-1", "human-2"]) {
      runtime.recordUser({ scopeId: "c1", channelId: "c1", id, text: repeated });
      const result = await handleWatcherRoute({ runtime, method: "POST", pathname: "/v1/watcher/evaluate", body: { ...input(id), trigger: "user" } });
      expect(result?.body).toMatchObject({ decision: "no_reply" });
    }
    expect((await runtime.evaluate(input("human-1"))).decision).toBe("no_reply");
    expect(new ConversationStore(db).listRawEvents("c1").map((event) => event.authorRole)).toEqual(["user", "user"]);
  });

  it("keeps original chronology and avoids collisions with synthetic intake IDs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const db = database(); const runtime = new ConversationRuntime(db, config);
    await runtime.evaluate(input("a1", "first distinct subject"));
    vi.setSystemTime(1_000_100); await runtime.evaluate(input("a2", "another unrelated subject"));
    vi.setSystemTime(1_000_200); await runtime.evaluate(input("a1", "first distinct subject"));
    expect(new ConversationStore(db).listRawEvents("c1").map((event) => event.messageId)).toEqual(["a1", "a2"]);
    runtime.recordUser({ scopeId: "human", id: "u-2", text: "first" });
    runtime.recordUser({ scopeId: "human", text: "second" });
    expect(new ConversationStore(db).listRawEvents("human").map((event) => event.text)).toEqual(["first", "second"]);
  });

  it("does not attribute an old repeated pair to a new topic", async () => {
    const runtime = new ConversationRuntime(database(), config);
    await runtime.evaluate(input("a1"));
    expect((await runtime.evaluate(input("a2"))).decision).toBe("nudge");
    expect(await runtime.evaluate(input("a3", "Purple elephants dance through rainbow clouds"))).toMatchObject({ decision: "no_reply", audit: null });
  });
});

describe("durable watcher dispatch", () => {
  it("adds dispatch state to a version-5 database without changing existing conversation data", () => {
    const root = mkdtempSync(join(tmpdir(), "hent-schema-upgrade-")); roots.push(root);
    const path = join(root, "service.sqlite");
    const prior = new ServiceDatabase(path);
    try {
      new ConversationRuntime(prior, config).recordUser({ scopeId: "c1", channelId: "c1", id: "old-user", text: "preserve me" });
      prior.db.exec("DROP TABLE conversation_delivery_dispatch; DELETE FROM schema_migrations WHERE version=6; INSERT OR IGNORE INTO schema_migrations VALUES (5, '2026-09-01'); PRAGMA user_version=5;");
    } finally { prior.close(); }
    const upgraded = database(path);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(6);
    expect(new ConversationStore(upgraded).listRawEvents("c1")).toMatchObject([{ messageId: "old-user", authorRole: "user", text: "preserve me" }]);
    expect(upgraded.db.prepare("SELECT * FROM conversation_delivery_dispatch").all()).toEqual([]);
    expect(upgraded.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("grants one plan across concurrent evaluations and service instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "hent-dispatch-")); roots.push(root);
    const path = join(root, "service.sqlite");
    const a = new ConversationRuntime(database(path), config);
    const b = new ConversationRuntime(database(path), config);
    await a.evaluate(input("a1"));
    const results = await Promise.all([a.evaluate(input("a2")), b.evaluate(input("a2")), a.evaluate(input("a3"))]);
    expect(results.filter((result) => result.decision === "nudge")).toHaveLength(1);
    expect(results.filter((result) => result.decision === "no_reply").every((result) => !result.deliveryPlan && !result.nudgeText)).toBe(true);
  });

  it("recovers expired unsent work with the frozen plan and durable receipts", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const db = database(); const first = new ConversationRuntime(db, config);
    await first.evaluate(input("a1"));
    const plan = (await first.evaluate(input("a2"))).deliveryPlan!;
    const chunk = plan.chunks[0]!;
    const progress = { planId: plan.planId, claimId: plan.dispatch!.claimId, chunkId: chunk.chunkId };
    expect(first.deliveryProgress({ ...progress, action: "begin" })).toBe(true);
    expect(first.deliveryProgress({ ...progress, action: "begin" })).toBe(false);
    expect(first.deliveryProgress({ ...progress, action: "receipt", messageId: "sent-1" })).toBe(true);
    expect(first.deliveryProgress({ ...progress, action: "receipt", messageId: "sent-1" })).toBe(true);
    vi.setSystemTime(1_000_000 + DELIVERY_CLAIM_MS + 1);
    const restarted = new ConversationRuntime(db, { ...config, maxChunkChars: 1800 });
    const recovered = (await restarted.evaluate(input("a2"))).deliveryPlan!;
    expect(recovered.chunks).toEqual(plan.chunks);
    expect(recovered.dispatch?.claimId).not.toBe(plan.dispatch?.claimId);
    expect(recovered.dispatch?.deliveryMessageIds).toEqual({ [chunk.chunkId]: "sent-1" });
    expect(first.deliveryProgress({ ...progress, action: "begin" })).toBe(false);
    const ids = { ...recovered.dispatch!.deliveryMessageIds };
    for (const next of recovered.chunks.slice(1)) {
      const request = { planId: plan.planId, claimId: recovered.dispatch!.claimId, chunkId: next.chunkId };
      expect(restarted.deliveryProgress({ ...request, action: "begin" })).toBe(true);
      ids[next.chunkId] = `sent-${next.metadata.chunkIndex + 1}`;
      expect(restarted.deliveryProgress({ ...request, action: "receipt", messageId: ids[next.chunkId] })).toBe(true);
    }
    const commit = { ...plan.commit, scopeId: plan.scopeId, deliveryMessageIds: ids };
    expect(restarted.commitDeliveryPlan(commit).status).toBe("committed");
    expect(restarted.commitDeliveryPlan(commit).status).toBe("idempotent");
    expect((await restarted.evaluate(input("a2"))).decision).toBe("no_reply");
  });

  it("does not resend an uncertain host send after expiry, but accepts its late receipt", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const runtime = new ConversationRuntime(database(), config);
    await runtime.evaluate(input("a1"));
    const plan = (await runtime.evaluate(input("a2"))).deliveryPlan!;
    const progress = { planId: plan.planId, claimId: plan.dispatch!.claimId, chunkId: plan.chunks[0]!.chunkId };
    expect(runtime.deliveryProgress({ ...progress, action: "begin" })).toBe(true);
    vi.setSystemTime(1_000_000 + DELIVERY_CLAIM_MS + 1);
    expect((await runtime.evaluate(input("a2"))).decision).toBe("no_reply");
    expect(runtime.deliveryProgress({ ...progress, action: "release" })).toBe(false);
    expect(runtime.deliveryProgress({ ...progress, action: "receipt", messageId: "late-id" })).toBe(true);
    expect(runtime.deliveryProgress({ ...progress, action: "release" })).toBe(true);
    expect((await runtime.evaluate(input("a2"))).deliveryPlan?.dispatch?.deliveryMessageIds).toEqual({ [progress.chunkId]: "late-id" });
  });

  it("keeps the claim valid through configured long delays and rejects sends after commit", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const runtime = new ConversationRuntime(database(), { ...config, minDelayMs: 90_000, maxDelayMs: 90_000 });
    await runtime.evaluate(input("a1"));
    const plan = (await runtime.evaluate(input("a2"))).deliveryPlan!;
    const ids: Record<string, string> = {};
    for (const chunk of plan.chunks) {
      vi.setSystemTime(Date.now() + chunk.delayMs);
      const progress = { planId: plan.planId, claimId: plan.dispatch!.claimId, chunkId: chunk.chunkId };
      expect(runtime.deliveryProgress({ ...progress, action: "begin" })).toBe(true);
      ids[chunk.chunkId] = `sent-${chunk.chunkId}`;
      expect(runtime.deliveryProgress({ ...progress, action: "receipt", messageId: ids[chunk.chunkId] })).toBe(true);
    }
    expect(runtime.commitDeliveryPlan({ ...plan.commit, scopeId: plan.scopeId, deliveryMessageIds: ids }).status).toBe("committed");
    expect(runtime.deliveryProgress({ planId: plan.planId, claimId: plan.dispatch!.claimId, action: "begin", chunkId: plan.chunks[0]!.chunkId })).toBe(false);
  });

  it("returns a conflict for an inconsistent legacy commit", async () => {
    const runtime = new ConversationRuntime(database(), config);
    const body = { scopeId: "legacy", signalId: "sig", cooldownKey: "legacy:k", deliveryMessageId: "first" };
    const call = (value: unknown) => handleWatcherRoute({ runtime, method: "POST", pathname: "/v1/watcher/commit-delivery", body: value });
    expect((await call(body))?.status).toBe(200);
    expect((await call({ ...body, deliveryMessageId: "different" }))?.status).toBe(409);
  });
});
