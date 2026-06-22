import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceDatabase } from "./db.js";
import { createConversationStore } from "./conversation-store.js";

const tempRoots: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hent-conversation-db-"));
  tempRoots.push(dir);
  return join(dir, "service.sqlite");
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("conversation schema repository", () => {
  it("creates service-owned conversation tables and migrates v1 data", () => {
    // Given: an existing v1 service database with canonical rows.
    const path = tempDbPath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, character TEXT, soul_snippet TEXT, model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE channel_settings (channel_id TEXT PRIMARY KEY, enabled INTEGER, cron_enabled INTEGER, asset_set_id TEXT, settings_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE verifier_cache (cache_key TEXT PRIMARY KEY, verdict_json TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run("2026-01-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO profiles (id, name, character, soul_snippet, model, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, ?, ?)")
      .run("gothic-v1", "Gothic", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO channel_settings (channel_id, enabled, cron_enabled, asset_set_id, settings_json, created_at, updated_at) VALUES (?, 1, 0, NULL, '{}', ?, ?)")
      .run("c1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO verifier_cache (cache_key, verdict_json, expires_at, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)")
      .run("cache-1", "{\"emotion\":\"neutral\"}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.close();

    // When: the current service database initializes the file.
    const db = new ServiceDatabase(path);

    // Then: conversation tables exist and existing service-owned rows survive.
    expect(db.tableNames()).toEqual(expect.arrayContaining([
      "conversation_raw_events",
      "conversation_checkpoints",
      "conversation_summaries",
      "conversation_delivery_ledger",
      "conversation_gate_state",
    ]));
    expect(db.getProfile("gothic-v1")).toMatchObject({ name: "Gothic" });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM channel_settings WHERE channel_id = 'c1'").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM verifier_cache WHERE cache_key = 'cache-1'").get()).toEqual({ count: 1 });
    db.close();
  });

  it("persists raw events, derived checkpoints, summaries, and prunes retained raw rows only", () => {
    // Given: a service-owned conversation store with raw events and derived memory.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    const oldEvent = store.recordRawEvent({
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      threadId: "t1",
      sessionId: "s1",
      messageId: "m-old",
      authorRole: "user",
      authorSource: "discord",
      text: "older room context",
      eventTs: "2026-06-01T00:00:00.000Z",
      observedAt: "2026-06-01T00:00:01.000Z",
      botSelfLoop: false,
    });
    const botEvent = store.recordRawEvent({
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      messageId: "m-bot",
      authorRole: "assistant",
      authorSource: "openclaw",
      text: "service delivered chunk",
      eventTs: "2026-06-21T00:00:00.000Z",
      observedAt: "2026-06-21T00:00:01.000Z",
      botSelfLoop: true,
    });

    // When: checkpoint and summary rows are written, then raw retention runs.
    store.upsertCheckpoint({
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      summary: "room is discussing deployment risk",
      recentEventIds: [oldEvent.id, botEvent.id],
      updatedAt: "2026-06-21T00:01:00.000Z",
    });
    const summary = store.addSummary({
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      summary: "The room discussed deployment risk and rollout timing.",
      sourceEventStartId: oldEvent.id,
      sourceEventEndId: botEvent.id,
      createdAt: "2026-06-21T00:02:00.000Z",
    });
    const pruned = store.pruneRawEvents({
      retentionDays: 14,
      now: "2026-06-22T00:00:00.000Z",
    });

    // Then: the old raw row is pruned, bot self-loop marker is readable, and summaries survive.
    expect(pruned).toBe(1);
    expect(store.listRawEvents("channel:c1:session:s1")).toMatchObject([
      { messageId: "m-bot", authorRole: "assistant", botSelfLoop: true },
    ]);
    expect(store.getCheckpoint("channel:c1:session:s1")).toMatchObject({
      summary: "room is discussing deployment risk",
      recentEventIds: [oldEvent.id, botEvent.id],
    });
    expect(store.listSummaries("channel:c1:session:s1")).toMatchObject([
      { id: summary.id, summary: "The room discussed deployment risk and rollout timing." },
    ]);
    db.close();
  });

  it("commits delivery ledger rows only after all host message ids exist and preserves gate state", () => {
    // Given: a delivery plan that requires two host-confirmed chunks.
    const db = new ServiceDatabase();
    const store = createConversationStore(db);
    const plan = store.createDeliveryPlan({
      planId: "plan-1",
      scopeId: "channel:c1:session:s1",
      channelId: "c1",
      signalId: "signal-1",
      cooldownKey: "channel:c1:session:s1:ambient",
      requiredChunkIds: ["chunk-1", "chunk-2"],
      createdAt: "2026-06-22T01:00:00.000Z",
    });

    // When: a partial commit arrives before every host send has confirmed.
    const partial = store.commitDelivery({
      planId: plan.planId,
      deliveryMessageIds: { "chunk-1": "discord-1" },
      committedAt: "2026-06-22T01:00:05.000Z",
      cooldownUntil: "2026-06-22T01:10:05.000Z",
      budgetWindowStart: "2026-06-22T01:00:00.000Z",
      budgetCount: 1,
    });

    // Then: no cooldown or message ids are committed yet.
    expect(partial.status).toBe("missing_required_chunks");
    expect(store.getDeliveryPlan(plan.planId)).toMatchObject({ status: "planned", deliveryMessageIds: {} });
    expect(store.getGateState("channel:c1:session:s1", "channel:c1:session:s1:ambient")).toBeNull();

    // When: all host send ids are confirmed, duplicate commit is retried, then a conflicting retry arrives.
    const committed = store.commitDelivery({
      planId: plan.planId,
      deliveryMessageIds: { "chunk-1": "discord-1", "chunk-2": "discord-2" },
      committedAt: "2026-06-22T01:00:06.000Z",
      cooldownUntil: "2026-06-22T01:10:06.000Z",
      budgetWindowStart: "2026-06-22T01:00:00.000Z",
      budgetCount: 1,
    });
    const duplicate = store.commitDelivery({
      planId: plan.planId,
      deliveryMessageIds: { "chunk-1": "discord-1", "chunk-2": "discord-2" },
      committedAt: "2026-06-22T01:00:07.000Z",
      cooldownUntil: "2026-06-22T01:10:07.000Z",
      budgetWindowStart: "2026-06-22T01:00:00.000Z",
      budgetCount: 1,
    });
    const conflict = store.commitDelivery({
      planId: plan.planId,
      deliveryMessageIds: { "chunk-1": "discord-1", "chunk-2": "different" },
      committedAt: "2026-06-22T01:00:08.000Z",
    });

    // Then: delivery commit is idempotent, conflicts are visible, and gate state is persisted for fail-closed decisions.
    expect(committed.status).toBe("committed");
    expect(duplicate.status).toBe("idempotent");
    expect(conflict.status).toBe("conflict");
    expect(store.getDeliveryPlan(plan.planId)).toMatchObject({
      status: "committed",
      deliveryMessageIds: { "chunk-1": "discord-1", "chunk-2": "discord-2" },
      committedAt: "2026-06-22T01:00:06.000Z",
    });
    expect(store.getGateState("channel:c1:session:s1", "channel:c1:session:s1:ambient")).toMatchObject({
      cooldownUntil: "2026-06-22T01:10:06.000Z",
      budgetWindowStart: "2026-06-22T01:00:00.000Z",
      budgetCount: 1,
      lastSignalId: "signal-1",
    });
    db.close();
  });
});
