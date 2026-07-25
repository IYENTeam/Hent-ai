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
      proposal: { decision: "speak" }, state: { drive: 0.625, version: 1 },
      relationships: [{ userId: "u1", rapportDelta: 0.1, familiarityDelta: 0.05, notes: ["helpful"] }],
      budget: { key: "ambient", count: 1, windowStartMs: fakeClock.now },
      plan: { id: "plan-1", workId: "work-valid", chunks: [{ content: "hello", nonce: "nonce-1" }] },
    })).toBe("applied");
    expect(store.state({ guildId: "g1", channelId: "c1" })).toEqual({ drive: 0.625, version: 1 });
    expect(store.counts()).toMatchObject({ audits: 1, states: 1, budgets: 1, relationships: 1, plans: 1 });

    work(store, "work-invalid");
    expect(store.claimWork("work-invalid", fence)).toBe(true);
    expect(store.recordOutcome({
      fence, eventId: "event-invalid", scope: { guildId: "g1", channelId: "c1" }, outcome: "invalid", diagnostic: "low confidence", workId: "work-invalid",
      state: { drive: 1, version: 99 }, relationships: [{ userId: "u2", rapportDelta: 0.1, familiarityDelta: 0.1, notes: ["must not persist"] }],
      budget: { key: "invalid", count: 99, windowStartMs: fakeClock.now }, plan: { id: "plan-invalid", workId: "work-invalid", chunks: [{ content: "must not persist", nonce: "nonce-invalid" }] },
    })).toBe("applied");
    expect(store.state({ guildId: "g1", channelId: "c1" })).toEqual({ drive: 0.625, version: 1 });
    expect(store.counts()).toMatchObject({ audits: 2, states: 1, budgets: 1, relationships: 1, plans: 1 });
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

  it("reopens a real v2 file as v3 with WAL and deterministic archive claim takeover", () => {
    const fakeClock = clock(); const path = databasePath(); const legacy = new Database(path);
    legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, 'old')").run(); legacy.close();
    const firstDb = new service.ServiceDatabase(path); const first = service.createAdaptiveAmbientStore(firstDb, fakeClock.read);
    expect(firstDb.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(firstDb.db.pragma("synchronous", { simple: true })).toBe(1);
    expect(firstDb.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(firstDb.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 3 });
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
});
