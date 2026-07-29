import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import * as service from "./index.js";

type Clock = { now: number; read: () => number; advance: (ms: number) => void };
const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "hent-adaptive-store-"));
  roots.push(root);
  return join(root, "service.sqlite");
}

function clock(start = 1_000_000): Clock {
  let now = start;
  return { get now() { return now; }, read: () => now, advance: (ms) => { now += ms; } };
}

function work(store: service.AdaptiveAmbientStore, id: string, eventId = id): void {
  expect(store.createWork({ id, eventId, eventDigest: `digest:${eventId}`, scope: { guildId: "g1", channelId: "c1" } })).toBe("created");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("adaptive ambient persistence", () => {
  it("atomically fences adaptive store transition", () => {
    const fakeClock = clock();
    const db = new service.ServiceDatabase();
    const store = service.createAdaptiveAmbientStore(db, fakeClock.read);
    const fence = store.acquireLease("discord-worker", "worker-a")!;
    work(store, "work-valid");
    expect(store.claimWork("work-valid", fence)).toBe(true);
    expect(store.recordOutcome({
      fence, eventId: "event-valid", scope: { guildId: "g1", channelId: "c1" }, outcome: "planned", workId: "work-valid",
      proposal: { decision: "speak" }, state: { drive: 0.625, version: 1, pressure: 0.35, pressureUpdatedAtMs: fakeClock.now },
      relationships: [{ userId: "u1", rapportDelta: 0.1, familiarityDelta: 0.05, notes: ["helpful"] }],
      budget: { key: "ambient", count: 1, windowStartMs: fakeClock.now },
      plan: { id: "plan-1", workId: "work-valid", chunks: [{ content: "hello", nonce: "nonce-1" }] },
    })).toBe("applied");
    expect(store.state({ guildId: "g1", channelId: "c1" })).toEqual({ drive: 0.625, version: 1, updatedAtMs: fakeClock.now, pressure: 0.35, pressureUpdatedAtMs: fakeClock.now, speakStreak: 0, skipStreak: 0 });
    expect(store.counts()).toMatchObject({ audits: 1, states: 1, budgets: 1, relationships: 1, plans: 1 });
    expect(db.db.prepare("SELECT guild_id,channel_id,user_id FROM adaptive_relationship_profiles").get()).toEqual({ guild_id: "g1", channel_id: "c1", user_id: "u1" });
    expect(db.db.prepare("SELECT event_id,channel_id,user_id FROM adaptive_relationship_ledger").get()).toEqual({ event_id: "event-valid", channel_id: "c1", user_id: "u1" });

    work(store, "work-invalid");
    expect(store.claimWork("work-invalid", fence)).toBe(true);
    expect(store.recordOutcome({
      fence, eventId: "event-invalid", scope: { guildId: "g1", channelId: "c1" }, outcome: "invalid", diagnostic: "low confidence", workId: "work-invalid",
      state: { drive: 1, version: 99 }, relationships: [{ userId: "u2", rapportDelta: 0.1, familiarityDelta: 0.1, notes: ["must not persist"] }],
      budget: { key: "invalid", count: 99, windowStartMs: fakeClock.now }, plan: { id: "plan-invalid", workId: "work-invalid", chunks: [{ content: "must not persist", nonce: "nonce-invalid" }] },
    })).toBe("applied");
    expect(store.state({ guildId: "g1", channelId: "c1" })).toEqual({ drive: 0.625, version: 1, updatedAtMs: fakeClock.now, pressure: 0.35, pressureUpdatedAtMs: fakeClock.now, speakStreak: 0, skipStreak: 0 });
    expect(store.counts()).toMatchObject({ audits: 2, states: 1, budgets: 1, relationships: 1, plans: 1 });
    db.close();
  });

  it("claims the latest actionable event as a fixed batch high-watermark", () => {
    const fakeClock = clock(); const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db, fakeClock.read);
    let fence = store.acquireLease("discord-worker", "worker-a")!;
    work(store, "work-old"); expect(store.claimWork("work-old", fence)).toBe(true);
    fakeClock.advance(30_001); fence = store.acquireLease("discord-worker", "worker-a")!;
    work(store, "work-latest");
    expect(store.claimNextWork({ guildId: "g1", channelId: "c1" }, fence)).toBe("work-latest");
    const watermark = store.work("work-latest")!;
    fakeClock.advance(1); work(store, "work-next-tick");

    expect(store.recordOutcome({
      fence, eventId: "work-latest", scope: { guildId: "g1", channelId: "c1" }, outcome: "observe", workId: "work-latest",
      batchHighWatermark: { createdAtMs: watermark.createdAtMs, workId: watermark.id }, state: { drive: 0.6, version: 1 },
    })).toBe("applied");
    expect(db.db.prepare("SELECT id,status FROM participant_event_work ORDER BY created_at_ms,id").all()).toEqual([
      { id: "work-old", status: "observe" },
      { id: "work-latest", status: "observe" },
      { id: "work-next-tick", status: "pending" },
    ]);
    db.close();
  });

  it("persists streak state and defaults stale null streaks to zero", () => {
    const fakeClock = clock(); const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db, fakeClock.read);
    const fence = store.acquireLease("discord-worker", "worker-a")!;
    work(store, "work-streak"); expect(store.claimWork("work-streak", fence)).toBe(true);
    expect(store.recordOutcome({
      fence, eventId: "event-streak", scope: { guildId: "g1", channelId: "c1" }, outcome: "planned", workId: "work-streak",
      state: { drive: 0.6, version: 1, speakStreak: 3, skipStreak: 0 },
    })).toBe("applied");
    expect(store.state({ guildId: "g1", channelId: "c1" })).toEqual({
      drive: 0.6, version: 1, updatedAtMs: fakeClock.now, pressure: 0, pressureUpdatedAtMs: null, speakStreak: 3, skipStreak: 0,
    });
    db.close();

    const path = databasePath(); const legacy = new Database(path);
    legacy.exec(`CREATE TABLE adaptive_ambient_state (
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, drive REAL NOT NULL, version INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      pressure REAL, pressure_updated_at_ms INTEGER, speak_streak INTEGER, skip_streak INTEGER, PRIMARY KEY(guild_id, channel_id)
    )`);
    legacy.prepare(`INSERT INTO adaptive_ambient_state (guild_id,channel_id,drive,version,updated_at_ms,pressure,pressure_updated_at_ms,speak_streak,skip_streak)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy", "channel", 0.4, 2, 42, 0.2, null, null, null);
    legacy.close();
    const legacyDb = new service.ServiceDatabase(path); const legacyStore = service.createAdaptiveAmbientStore(legacyDb);
    expect(legacyStore.state({ guildId: "legacy", channelId: "channel" })).toEqual({
      drive: 0.4, version: 2, updatedAtMs: 42, pressure: 0.2, pressureUpdatedAtMs: null, speakStreak: 0, skipStreak: 0,
    });
    legacyDb.close();
  });

  it("returns legacy pressure rows with a null pressure timestamp", () => {
    const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db);
    db.db.prepare("INSERT INTO adaptive_ambient_state (guild_id,channel_id,drive,version,updated_at_ms,pressure,pressure_updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("g1", "c1", 0.6, 2, 42, 0.4, null);
    expect(store.state({ guildId: "g1", channelId: "c1" })).toEqual({ drive: 0.6, version: 2, updatedAtMs: 42, pressure: 0.4, pressureUpdatedAtMs: null, speakStreak: 0, skipStreak: 0 });
    db.close();
  });

  it("rolls back every staged transition row after a forced error", () => {
    const fakeClock = clock(); const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db, fakeClock.read);
    const fence = store.acquireLease("discord-worker", "worker-a")!;
    work(store, "work-rollback"); expect(store.claimWork("work-rollback", fence)).toBe(true);
    expect(() => store.recordOutcome({ fence, eventId: "event-rollback", scope: { guildId: "g1", channelId: "c1" }, outcome: "observe", workId: "work-rollback", state: { drive: 0.6, version: 1 }, failAfterAudit: true })).toThrow("forced adaptive transition failure");
    expect(store.counts()).toEqual({ audits: 0, states: 0, budgets: 0, relationships: 0, plans: 0 });
    db.close();
  });

  it("takes over expired leases with a new fence while stale owners cannot mutate", () => {
    const fakeClock = clock(); const path = databasePath();
    const firstDb = new service.ServiceDatabase(path); const secondDb = new service.ServiceDatabase(path);
    const first = service.createAdaptiveAmbientStore(firstDb, fakeClock.read); const second = service.createAdaptiveAmbientStore(secondDb, fakeClock.read);
    const fenceA = first.acquireLease("discord-worker", "worker-a")!;
    expect(second.acquireLease("discord-worker", "worker-b")).toBeNull();
    fakeClock.advance(10_000);
    expect(first.renewLease(fenceA)).toMatchObject({ fenceToken: fenceA.fenceToken, expiresAtMs: fakeClock.now + 30_000 });
    work(first, "work-fenced"); expect(first.claimWork("work-fenced", fenceA)).toBe(true);
    fakeClock.advance(30_001);
    const fenceB = second.acquireLease("discord-worker", "worker-b")!;
    expect(fenceB.fenceToken).toBe(fenceA.fenceToken + 1);
    expect(second.claimWork("work-fenced", fenceB)).toBe(true);
    expect(() => first.recordOutcome({ fence: fenceA, eventId: "event-fenced", scope: { guildId: "g1", channelId: "c1" }, outcome: "observe", workId: "work-fenced", state: { drive: 0.6, version: 1 } })).toThrow("stale fence");
    expect(second.state({ guildId: "g1", channelId: "c1" })).toBeNull();
    firstDb.close(); secondDb.close();
  });

  it("rejects immutable digest conflicts and accepts identical replays", () => {
    const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db);
    expect(store.createWork({ id: "work-1", eventId: "event-1", eventDigest: "a", scope: { guildId: "g1", channelId: "c1" } })).toBe("created");
    expect(store.createWork({ id: "work-2", eventId: "event-1", eventDigest: "a", scope: { guildId: "g1", channelId: "c1" } })).toBe("idempotent");
    expect(() => store.createWork({ id: "work-3", eventId: "event-1", eventDigest: "different", scope: { guildId: "g1", channelId: "c1" } })).toThrow("event digest conflict");
    db.close();
  });

  it("upgrades a real v3 file to v4 additively without changing legacy ambient rows", () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE adaptive_ambient_audits (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, outcome TEXT NOT NULL, diagnostic TEXT, proposal_json TEXT, recorded_at_ms INTEGER NOT NULL, UNIQUE(event_id, guild_id, channel_id));
      CREATE TABLE adaptive_relationship_profiles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, rapport REAL NOT NULL DEFAULT 0.5, familiarity REAL NOT NULL DEFAULT 0.5, notes_json TEXT NOT NULL DEFAULT '[]', updated_at_ms INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id));
      CREATE TABLE adaptive_relationship_ledger (event_id TEXT NOT NULL, user_id TEXT NOT NULL, proposal_index INTEGER NOT NULL, guild_id TEXT NOT NULL, rapport_delta REAL NOT NULL, familiarity_delta REAL NOT NULL, notes_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(event_id, user_id, proposal_index));
      CREATE TABLE adaptive_ambient_state (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, drive REAL NOT NULL CHECK(drive >= 0 AND drive <= 1), version INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(guild_id, channel_id));
    `);
    legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (3, 'old')").run();
    legacy.pragma("user_version = 3");
    legacy.prepare("INSERT INTO adaptive_relationship_profiles (guild_id, user_id, rapport, familiarity, notes_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run("g1", "u1", 0.75, 0.25, '["legacy note"]', 42);
    legacy.prepare("INSERT INTO adaptive_relationship_ledger (event_id, user_id, proposal_index, guild_id, rapport_delta, familiarity_delta, notes_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("event-1", "u1", 0, "g1", 0.25, -0.25, '["legacy note"]', 42);
    legacy.prepare("INSERT INTO adaptive_ambient_state (guild_id, channel_id, drive, version, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run("g1", "c1", 0.75, 3, 42);
    legacy.prepare("INSERT INTO adaptive_ambient_audits (event_id, guild_id, channel_id, outcome, diagnostic, proposal_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("event-1", "g1", "c1", "planned", "legacy", '{"decision":"speak"}', 42);
    expect(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 3 });
    expect(legacy.pragma("user_version", { simple: true })).toBe(3);
    legacy.close();

    const upgraded = new service.ServiceDatabase(path);
    expect(upgraded.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 6 });
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(6);
    for (const [table, columns] of [
      ["adaptive_ambient_audits", ["evidence_weight", "probability", "draw", "drive_before", "drive_after", "active_human_count", "roster_fresh"]],
      ["adaptive_relationship_profiles", ["channel_id"]],
      ["adaptive_relationship_ledger", ["channel_id"]],
      ["adaptive_ambient_state", ["pressure", "pressure_updated_at_ms", "speak_streak", "skip_streak"]],
    ] as const) {
      const actual = upgraded.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name);
      expect(actual).toEqual(expect.arrayContaining([...columns]));
    }
    expect(upgraded.db.prepare("SELECT guild_id, channel_id, drive, version, updated_at_ms, pressure, pressure_updated_at_ms, speak_streak, skip_streak FROM adaptive_ambient_state").get()).toEqual({
      guild_id: "g1", channel_id: "c1", drive: 0.75, version: 3, updated_at_ms: 42, pressure: 0, pressure_updated_at_ms: null, speak_streak: 0, skip_streak: 0,
    });
    expect(upgraded.db.prepare("SELECT event_id, guild_id, channel_id, outcome, diagnostic, proposal_json, recorded_at_ms, evidence_weight, probability, draw, drive_before, drive_after, active_human_count, roster_fresh FROM adaptive_ambient_audits").get()).toEqual({
      event_id: "event-1", guild_id: "g1", channel_id: "c1", outcome: "planned", diagnostic: "legacy", proposal_json: '{"decision":"speak"}', recorded_at_ms: 42,
      evidence_weight: null, probability: null, draw: null, drive_before: null, drive_after: null, active_human_count: null, roster_fresh: null,
    });
    expect(upgraded.db.prepare("SELECT guild_id, channel_id, user_id, rapport, familiarity, notes_json, updated_at_ms FROM adaptive_relationship_profiles").get()).toEqual({
      guild_id: "g1", channel_id: "", user_id: "u1", rapport: 0.75, familiarity: 0.25, notes_json: '["legacy note"]', updated_at_ms: 42,
    });
    expect(upgraded.db.prepare("SELECT event_id, channel_id, user_id, proposal_index, guild_id, rapport_delta, familiarity_delta, notes_json, created_at_ms FROM adaptive_relationship_ledger").get()).toEqual({
      event_id: "event-1", channel_id: "", user_id: "u1", proposal_index: 0, guild_id: "g1", rapport_delta: 0.25, familiarity_delta: -0.25, notes_json: '["legacy note"]', created_at_ms: 42,
    });
    const index = upgraded.db.prepare("SELECT name FROM pragma_index_list('adaptive_relationship_profiles') WHERE name = 'idx_adaptive_relationship_profiles_guild_channel_user'").get();
    expect(index).toEqual({ name: "idx_adaptive_relationship_profiles_guild_channel_user" });
    expect(upgraded.db.prepare("SELECT name FROM pragma_index_info('idx_adaptive_relationship_profiles_guild_channel_user') ORDER BY seqno").all()).toEqual([
      { name: "guild_id" }, { name: "channel_id" }, { name: "user_id" },
    ]);

    expect(() => upgraded.initialize()).not.toThrow();
    expect(upgraded.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6").get()).toEqual({ count: 1 });
    expect(upgraded.db.prepare("SELECT COUNT(*) AS count FROM pragma_index_list('adaptive_relationship_profiles') WHERE name = 'idx_adaptive_relationship_profiles_guild_channel_user'").get()).toEqual({ count: 1 });
    upgraded.close();
  });

  it("reopens a real v2 file as v4 with WAL and deterministic archive claim takeover", () => {
    const fakeClock = clock(); const path = databasePath(); const legacy = new Database(path);
    legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, 'old')").run(); legacy.close();
    const firstDb = new service.ServiceDatabase(path); const first = service.createAdaptiveAmbientStore(firstDb, fakeClock.read);
    expect(firstDb.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(firstDb.db.pragma("synchronous", { simple: true })).toBe(1);
    expect(firstDb.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(firstDb.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 6 });
    const fenceA = first.acquireLease("archive", "worker-a")!;
    expect(first.claimArchiveBatch({ batchKey: "g1:c1:1:2", summaryKey: "summary:g1:c1:1:2", scopeId: "g1:c1", sourceStartId: 1, sourceEndId: 2, fence: fenceA })).toBe(true);
    fakeClock.advance(30_001);
    const secondDb = new service.ServiceDatabase(path); const second = service.createAdaptiveAmbientStore(secondDb, fakeClock.read);
    const fenceB = second.acquireLease("archive", "worker-b")!;
    let renewedFenceB = fenceB;
    for (let index = 0; index < 9; index += 1) {
      fakeClock.advance(10_000);
      renewedFenceB = second.renewLease(renewedFenceB)!;
    }
    expect(second.claimArchiveBatch({ batchKey: "g1:c1:1:2", summaryKey: "summary:g1:c1:1:2", scopeId: "g1:c1", sourceStartId: 1, sourceEndId: 2, fence: renewedFenceB })).toBe(true);
    expect(second.completeArchiveBatch("g1:c1:1:2", "permanent summary", renewedFenceB)).toBe(true);
    expect(secondDb.db.prepare("SELECT COUNT(*) AS count FROM conversation_archive_summaries").get()).toEqual({ count: 1 });
    firstDb.close(); secondDb.close();
  });
  it("persists V5 participation invariants, apply coalescing, and shadow isolation in a real database", () => {
    const fakeClock = clock(); const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db, fakeClock.read);
    const fence = store.acquireLease("discord-ambient-worker", "v5-store")!;
    const snapshot = { highWatermarkId: 1, json: '{"turns":[]}', utf8Bytes: 12, digest: "d5fb095584e9f878eda4919412601f834c18fc24b3310d16ce21830a025a95f8", turns: [] as const };
    const persona = { source: "generic" as const, text: "persona", utf8Bytes: 7, digest: "5e815286bca594454b291f3b0350ec22aab6de20b6d9efeec67d604f6bce65ee", revision: "c".repeat(64) };
    db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
      VALUES (?, ?, ?, 'user', 'discord-participant', ?, ?, ?, 0, '{}', ?)`)
      .run("discord:g1:c1", "c1", "raw-1", "source is immutable", new Date(fakeClock.now).toISOString(), new Date(fakeClock.now).toISOString(), new Date(fakeClock.now).toISOString());
    const rawId = Number((db.db.prepare("SELECT id FROM conversation_raw_events WHERE message_id='raw-1'").get() as { id: number }).id);
    const bound = { ...snapshot, highWatermarkId: rawId };
    expect(store.bindParticipationTick({ id: "forged-tick", scope: { guildId: "g1", channelId: "c1" }, mode: "shadow", primaryContractVersion: "v2",
      anchorWorkId: "forged-anchor", snapshot: { ...bound, utf8Bytes: 11 }, persona, coverageWorkIds: [], fence })).toBe(false);
    expect(store.bindParticipationTick({ id: "multibyte-tick", scope: { guildId: "g1", channelId: "c1" }, mode: "shadow", primaryContractVersion: "v2",
      anchorWorkId: "multibyte-anchor", snapshot: bound, persona: { ...persona, text: "é".repeat(4_097), utf8Bytes: 4_097 }, coverageWorkIds: [], fence })).toBe(false);
    for (const id of ["apply-anchor", "apply-covered"]) db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
      VALUES ('discord:g1:c1','c1',NULL,NULL,?,'user','discord-participant',?, ?, ?,0,?,?)`).run(id,id,new Date(fakeClock.now).toISOString(),new Date(fakeClock.now).toISOString(),JSON.stringify({ discordAuthorId: id, discordAuthorBot: false }),new Date(fakeClock.now).toISOString());
    work(store, "apply-covered"); fakeClock.advance(1); work(store, "apply-anchor");
    const applyBound = { ...bound, highWatermarkId: Number((db.db.prepare("SELECT MAX(id) AS id FROM conversation_raw_events").get() as { id: number }).id) };
    expect(store.bindParticipationTick({ id: "apply-tick", scope: { guildId: "g1", channelId: "c1" }, mode: "apply", primaryContractVersion: "v2",
      anchorWorkId: "apply-anchor", snapshot: applyBound, persona, coverageWorkIds: ["apply-anchor", "apply-covered"], fence })).toBe(true);
    expect(db.db.prepare("SELECT id,status,participation_tick_id FROM participant_event_work ORDER BY id").all()).toEqual([
      { id: "apply-anchor", status: "retryable", participation_tick_id: "apply-tick" },
      { id: "apply-covered", status: "covered", participation_tick_id: "apply-tick" },
    ]);
    expect(store.claimParticipationPrimary("apply-tick", fence)).toBe(true);
    expect(store.persistParticipationPrimary({ tickId: "apply-tick", fence, resultJson: '{"decision":"speak"}', resultUtf8Bytes: 20, resultDigest: "80e08356443a55bc10677213dfd8121a10cab2d735c574f691f1ed6534d0dbf4",
      decision: "speak", validationSchemaVersion: "validator-v2", validatorModel: "mock", chunks: ["one"], workId: "apply-anchor",
      scope: { guildId: "g1", channelId: "c1" } })).toBe(true);
    const planId = "participation:apply-tick";
    expect(store.cancelDelivery(planId, fence)).toBe(true);
    expect(db.db.prepare("SELECT status FROM participant_event_work WHERE id='apply-anchor'").get()).toEqual({ status: "observe" });
    expect(store.claimParticipationValidation("apply-tick", fence)).toBe(true);
    expect(store.completeParticipationValidation("apply-tick", { missedOpportunity: 0, interruption: 0, confidence: 1, priorDelta: 0.05, rationale: "validated", rationaleUtf8Bytes: 9 }, fence)).toBe("applied");
    expect(store.completeParticipationValidation("apply-tick", { missedOpportunity: 1, interruption: 1, confidence: 0, priorDelta: 0.05, rationale: "replay", rationaleUtf8Bytes: 6 }, fence)).toBe("idempotent");
    expect(store.participationPrior({ guildId: "g1", channelId: "c1" }, persona.revision, "v2")).toBe(0.05);
    expect(db.db.prepare("SELECT text FROM conversation_raw_events WHERE id=?").get(rawId)).toEqual({ text: "source is immutable" });
    expect(db.db.prepare("SELECT snapshot_digest,persona_digest,primary_result_digest FROM conversation_participation_ticks WHERE id='apply-tick'").get()).toEqual({
      snapshot_digest: "d5fb095584e9f878eda4919412601f834c18fc24b3310d16ce21830a025a95f8", persona_digest: "5e815286bca594454b291f3b0350ec22aab6de20b6d9efeec67d604f6bce65ee", primary_result_digest: "80e08356443a55bc10677213dfd8121a10cab2d735c574f691f1ed6534d0dbf4",
    });

    db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
      VALUES ('discord:g1:c1','c1',NULL,NULL,'shadow-anchor','user','discord-participant','shadow', ?, ?,0,?,?)`).run(new Date(fakeClock.now).toISOString(),new Date(fakeClock.now).toISOString(),JSON.stringify({ discordAuthorId: "shadow", discordAuthorBot: false }),new Date(fakeClock.now).toISOString());
    work(store, "shadow-anchor");
    const shadowBound = { ...bound, highWatermarkId: Number((db.db.prepare("SELECT MAX(id) AS id FROM conversation_raw_events").get() as { id: number }).id) };
    expect(store.bindParticipationTick({ id: "shadow-tick", scope: { guildId: "g1", channelId: "c1" }, mode: "shadow", primaryContractVersion: "v2",
      anchorWorkId: "shadow-anchor", snapshot: shadowBound, persona, coverageWorkIds: ["shadow-anchor"], fence })).toBe(true);
    expect(db.db.prepare("SELECT status,participation_tick_id FROM participant_event_work WHERE id='shadow-anchor'").get()).toEqual({ status: "pending", participation_tick_id: null });
    expect(store.claimParticipationPrimary("shadow-tick", fence)).toBe(true);
    expect(store.persistParticipationPrimary({ tickId: "shadow-tick", fence, resultJson: '{"decision":"speak"}', resultUtf8Bytes: 20, resultDigest: "80e08356443a55bc10677213dfd8121a10cab2d735c574f691f1ed6534d0dbf4",
      decision: "speak", validationSchemaVersion: "validator-v2", validatorModel: "mock" })).toBe(true);
    expect(store.claimParticipationValidation("shadow-tick", fence)).toBe(true);
    expect(store.completeParticipationValidation("shadow-tick", { missedOpportunity: 1, interruption: 0, confidence: 1, priorDelta: 0.05, rationale: "shadow", rationaleUtf8Bytes: 6 }, fence)).toBe("accepted_shadow");
    expect(store.participationPrior({ guildId: "g1", channelId: "c1" }, persona.revision, "v2")).toBe(0.05);
    expect(db.db.prepare("SELECT status FROM participant_event_work WHERE id='shadow-anchor'").get()).toEqual({ status: "pending" });
    work(store, "v1-work"); expect(store.claimWork("v1-work", fence)).toBe(true);
    expect(store.recordOutcome({ fence, eventId: "v1-work", scope: { guildId: "g1", channelId: "c1" }, outcome: "planned", workId: "v1-work",
      state: { drive: 0.7, version: 1 }, plan: { id: "v1-plan", workId: "v1-work", chunks: [{ content: "legacy", nonce: "v1-nonce" }] } })).toBe("applied");
    expect(store.cancelDelivery("v1-plan", fence)).toBe(true);
    expect(db.db.prepare("SELECT status FROM participant_event_work WHERE id='v1-work'").get()).toEqual({ status: "observe" });
    expect(() => db.db.prepare(`INSERT INTO conversation_participation_ticks (id,guild_id,channel_id,mode,primary_contract_version,status,anchor_work_id,snapshot_high_watermark_id,snapshot_json,snapshot_utf8_bytes,snapshot_digest,persona_source,persona_text,persona_utf8_bytes,persona_digest,persona_revision,created_at_ms,updated_at_ms)
      VALUES ('bad','g1','c1','apply','v2','primary_claimed','apply-anchor',?,'{}',2,?,'generic','p',1,?,?,?,?)`).run(rawId, "a".repeat(64), "b".repeat(64), "c".repeat(64), fakeClock.now, fakeClock.now)).toThrow();
    db.close();
  });
});
