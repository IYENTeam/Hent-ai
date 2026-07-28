import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as service from "./index.js";

const roots: string[] = [];

function clock(start = Date.parse("2026-06-22T00:00:00.000Z")): { now: number; read: () => number; advance: (ms: number) => void } {
  let now = start;
  return { get now() { return now; }, read: () => now, advance: (ms) => { now += ms; } };
}

function filePath(): string {
  const root = mkdtempSync(join(tmpdir(), "hent-archive-scheduler-"));
  roots.push(root);
  return join(root, "service.sqlite");
}

function recordOldEvent(store: service.ConversationStore, id = "old-1", scopeId = "guild:channel", channelId = "channel"): service.ConversationRawEvent {
  return store.recordRawEvent({
    scopeId, channelId, messageId: id, authorRole: "user", authorSource: "discord",
    text: `old transcript ${id}`, eventTs: "2026-06-01T00:00:00.000Z", observedAt: "2026-06-01T00:00:00.000Z",
  });
}

function provider(onCompact?: () => void, failure = false): service.ConversationMemoryCompactionProvider {
  return {
    compact: async (request) => {
      onCompact?.();
      if (failure) throw new Error("provider unavailable");
      return JSON.stringify({
        schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction,
        scopeId: request.scope.scopeId,
        sourceMessageIds: request.sourceEvents.map((event) => event.messageId),
        summary: `archive:${request.sourceEvents.map((event) => event.messageId).join(",")}`,
        durableFacts: ["archived fact"], confidence: 0.9,
      });
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("conversation archive scheduler", () => {
  it("archives batches and derives fresh roster evidence", async () => {
    // The same index-namespace assertion intentionally supplied the prospective RED seam.
    expect(service).toHaveProperty("createConversationArchiveScheduler");
    const fakeClock = clock();
    const db = new service.ServiceDatabase();
    const store = service.createConversationStore(db);
    const archiveStore = service.createAdaptiveAmbientStore(db, fakeClock.read);
    recordOldEvent(store);
    let fence = archiveStore.acquireLease("archive", "worker-a")!;
    const timer: { callback: (() => void) | null } = { callback: null };
    let compactCount = 0;
    let notifySecondCompact: (() => void) | null = null;
    const secondCompact = new Promise<void>((resolve) => { notifySecondCompact = resolve; });
    const scheduler = service.createConversationArchiveScheduler({
      store, archiveStore, provider: provider(() => { compactCount += 1; if (compactCount === 2) notifySecondCompact?.(); }), fence,
      rawRetentionDays: 14, clock: fakeClock.read,
      timer: { setInterval: (callback, intervalMs) => { expect(intervalMs).toBe(6 * 60 * 60 * 1000); timer.callback = callback; return callback; }, clearInterval: () => undefined },
    });

    await scheduler.ready;
    expect(store.listRawEvents("guild:channel")).toHaveLength(1);
    expect(store.listActiveRawEvents("guild:channel")).toEqual([]);
    expect(store.listArchivedSummaries("guild:channel")).toMatchObject([{ summary: "archive:old-1" }]);
    expect(service.recordConversationUserIntake({
      store, scopeId: "guild:channel", channelId: "channel", messageId: "fresh", text: "fresh active room context",
      observedAt: "2026-06-22T00:00:00.000Z", maxRecentEvents: 10,
    }).summary).toContain("Archived room context: archive:old-1");
    recordOldEvent(store, "old-2");
    timer.callback!();
    await secondCompact;
    await scheduler.run();
    scheduler.stop();
    expect(compactCount).toBe(2);
    db.close();
  });

  it("stabilizes retry batches on their persisted source identity before compacting new events", async () => {
    const fakeClock = clock();
    const db = new service.ServiceDatabase();
    const store = service.createConversationStore(db);
    const archiveStore = service.createAdaptiveAmbientStore(db, fakeClock.read);
    const first = recordOldEvent(store, "old-1");
    let fence = archiveStore.acquireLease("archive", "worker-a")!;
    const failed = service.createConversationArchiveScheduler({
      store, archiveStore, provider: provider(undefined, true), fence, rawRetentionDays: 14, clock: fakeClock.read,
      timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    await failed.ready;
    recordOldEvent(store, "old-2");
    const beforeDue: string[][] = [];
    const separate = service.createConversationArchiveScheduler({
      store, archiveStore, provider: { compact: async (request) => { beforeDue.push(request.sourceEvents.map((event) => event.messageId)); return JSON.stringify({ schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction, scopeId: request.scope.scopeId, sourceMessageIds: request.sourceEvents.map((event) => event.messageId), summary: "separate", durableFacts: [], confidence: 1 }); } }, fence,
      rawRetentionDays: 14, clock: fakeClock.read, timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    await separate.ready;
    expect(beforeDue).toEqual([["old-2"]]);
    for (let index = 0; index < 12; index += 1) { fakeClock.advance(10_000); fence = archiveStore.renewLease(fence)!; }
    const retry: string[][] = [];
    const recovered = service.createConversationArchiveScheduler({
      store, archiveStore, provider: { compact: async (request) => { retry.push(request.sourceEvents.map((event) => event.messageId)); return JSON.stringify({ schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction, scopeId: request.scope.scopeId, sourceMessageIds: request.sourceEvents.map((event) => event.messageId), summary: "retry", durableFacts: [], confidence: 1 }); } }, fence,
      rawRetentionDays: 14, clock: fakeClock.read, timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    await recovered.ready;
    expect(retry).toEqual([["old-1"]]);
    expect(db.db.prepare("SELECT batch_key,source_event_ids_json,status FROM conversation_archive_batches WHERE source_start_id=?").get(first.id)).toEqual({ batch_key: `archive-v1:guild:channel:${first.id}:${first.id}`, source_event_ids_json: JSON.stringify([first.id]), status: "completed" });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM conversation_archive_summaries").get()).toEqual({ count: 2 });
    db.close();
  });

  it("takes over an expired claimed batch with its persisted key and source IDs", async () => {
    const fakeClock = clock(); const path = filePath();
    const firstDb = new service.ServiceDatabase(path); const firstStore = service.createConversationStore(firstDb);
    const firstArchive = service.createAdaptiveAmbientStore(firstDb, fakeClock.read); const event = recordOldEvent(firstStore, "crashed");
    const fenceA = firstArchive.acquireLease("archive", "worker-a")!;
    const batchKey = `archive-v1:guild:channel:${event.id}:${event.id}`;
    expect(firstArchive.claimArchiveBatch({ batchKey, summaryKey: `archive-summary-v1:${batchKey}`, scopeId: "guild:channel", sourceStartId: event.id, sourceEndId: event.id, sourceEventIds: [event.id], fence: fenceA })).toBe(true);
    fakeClock.advance(120_001);
    const secondDb = new service.ServiceDatabase(path); const secondArchive = service.createAdaptiveAmbientStore(secondDb, fakeClock.read);
    const fenceB = secondArchive.acquireLease("archive", "worker-b")!; const compacted: string[][] = [];
    const recovered = service.createConversationArchiveScheduler({
      store: service.createConversationStore(secondDb), archiveStore: secondArchive,
      provider: { compact: async (request) => { compacted.push(request.sourceEvents.map((source) => source.messageId)); return JSON.stringify({ schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction, scopeId: request.scope.scopeId, sourceMessageIds: request.sourceEvents.map((source) => source.messageId), summary: "crash-recovered", durableFacts: [], confidence: 1 }); } },
      fence: fenceB, rawRetentionDays: 14, clock: fakeClock.read, timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    await recovered.ready;
    expect(compacted).toEqual([["crashed"]]);
    expect(secondDb.db.prepare("SELECT batch_key,source_event_ids_json,status FROM conversation_archive_batches").get()).toEqual({ batch_key: batchKey, source_event_ids_json: JSON.stringify([event.id]), status: "completed" });
    expect(secondDb.db.prepare("SELECT COUNT(*) AS count FROM conversation_archive_summaries").get()).toEqual({ count: 1 });
    firstDb.close(); secondDb.close();
  });

  it("calls the provider outside a transaction, retries failures, and takes over expired batch claims without duplicate summaries", async () => {
    const fakeClock = clock();
    const path = filePath();
    const firstDb = new service.ServiceDatabase(path);
    const firstStore = service.createConversationStore(firstDb);
    const firstArchiveStore = service.createAdaptiveAmbientStore(firstDb, fakeClock.read);
    const event = recordOldEvent(firstStore);
    let fenceA = firstArchiveStore.acquireLease("archive", "worker-a")!;
    const batchKey = `archive-v1:guild:channel:${event.id}:${event.id}`;
    expect(firstArchiveStore.claimArchiveBatch({ batchKey, summaryKey: `archive-summary-v1:${batchKey}`, scopeId: "guild:channel", sourceStartId: event.id, sourceEndId: event.id, fence: fenceA })).toBe(true);
    expect(firstArchiveStore.retryArchiveBatch(batchKey, fenceA)).toBe(true);

    for (let index = 0; index < 12; index += 1) { fakeClock.advance(10_000); fenceA = firstArchiveStore.renewLease(fenceA)!; }
    let observedOutsideTransaction = false;
    const retryScheduler = service.createConversationArchiveScheduler({
      store: firstStore, archiveStore: firstArchiveStore,
      provider: provider(() => {
        if (firstDb.db.inTransaction) throw new Error("provider called within a SQLite transaction");
        observedOutsideTransaction = true;
      }, true), fence: fenceA,
      rawRetentionDays: 14, clock: fakeClock.read, timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    expect(await retryScheduler.ready).toMatchObject({ retryableBatchCount: 1 });
    expect(observedOutsideTransaction).toBe(true);
    expect(firstDb.db.prepare("SELECT status FROM conversation_archive_batches WHERE batch_key=?").get(batchKey)).toEqual({ status: "retryable" });

    fakeClock.advance(30_001);
    const secondDb = new service.ServiceDatabase(path);
    const secondStore = service.createConversationStore(secondDb);
    const secondArchiveStore = service.createAdaptiveAmbientStore(secondDb, fakeClock.read);
    let fenceB = secondArchiveStore.acquireLease("archive", "worker-b")!;
    for (let index = 0; index < 9; index += 1) { fakeClock.advance(10_000); fenceB = secondArchiveStore.renewLease(fenceB)!; }
    const takeoverScheduler = service.createConversationArchiveScheduler({
      store: secondStore, archiveStore: secondArchiveStore, provider: provider(), fence: fenceB,
      rawRetentionDays: 14, clock: fakeClock.read, timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    expect(await takeoverScheduler.ready).toMatchObject({ claimedBatchCount: 1, completedBatchCount: 1 });
    expect(await takeoverScheduler.run()).toMatchObject({ claimedBatchCount: 0, completedBatchCount: 0 });
    expect(secondDb.db.prepare("SELECT COUNT(*) AS count FROM conversation_archive_summaries").get()).toEqual({ count: 1 });
    firstDb.close();
    secondDb.close();

    const reopened = new service.ServiceDatabase(path);
    const reopenedStore = service.createConversationStore(reopened);
    expect(reopenedStore.listRawEvents("guild:channel")).toHaveLength(1);
    expect(reopenedStore.listArchivedSummaries("guild:channel")).toHaveLength(1);
    reopened.close();
  });

  it("recovers equal-timestamp source ids in numeric conversation order", async () => {
    const fakeClock = clock();
    const db = new service.ServiceDatabase();
    const store = service.createConversationStore(db);
    const archiveStore = service.createAdaptiveAmbientStore(db, fakeClock.read);
    for (let index = 1; index <= 10; index += 1) recordOldEvent(store, `same-${index}`);
    let fence = archiveStore.acquireLease("archive", "worker-a")!;
    let shouldFail = true;
    let compactCount = 0;
    const scheduler = service.createConversationArchiveScheduler({
      store,
      archiveStore,
      provider: {
        compact: async (request) => {
          compactCount += 1;
          if (shouldFail) throw new Error("provider unavailable");
          return JSON.stringify({
            schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction,
            scopeId: request.scope.scopeId,
            sourceMessageIds: request.sourceEvents.map((event) => event.messageId),
            summary: "equal timestamp archive",
            durableFacts: [],
            confidence: 0.9,
          });
        },
      },
      fence,
      rawRetentionDays: 14,
      clock: fakeClock.read,
      timer: { setInterval: () => 0, clearInterval: () => undefined },
    });

    expect(await scheduler.ready).toMatchObject({ claimedBatchCount: 1, retryableBatchCount: 1 });
    shouldFail = false;
    for (let index = 0; index < 12; index += 1) {
      fakeClock.advance(10_000);
      fence = archiveStore.renewLease(fence)!;
    }
    expect(await scheduler.run()).toMatchObject({ claimedBatchCount: 1, completedBatchCount: 1 });
    expect(compactCount).toBe(2);
    expect(store.listArchivedSummaries("guild:channel")).toHaveLength(1);
    db.close();
  });

  it("authorizes exact Discord archive scopes before fresh and persisted provider calls", async () => {
    const fakeClock = clock(); const db = new service.ServiceDatabase(); const store = service.createConversationStore(db);
    const archiveStore = service.createAdaptiveAmbientStore(db, fakeClock.read); let fence = archiveStore.acquireLease("archive", "worker-a")!;
    const authorizedScope = "discord:100000000000000001:100000000000000011";
    const unauthorizedScope = "discord:100000000000000002:100000000000000012";
    recordOldEvent(store, "allowed", authorizedScope, "100000000000000011");
    recordOldEvent(store, "disabled", authorizedScope.replace("011", "013"), "100000000000000013");
    recordOldEvent(store, "non-allowlisted", unauthorizedScope, "100000000000000012");
    recordOldEvent(store, "legacy", "legacy raw transcript", "100000000000000011");
    let enabled = true; const freshBodies: unknown[] = [];
    const fresh = service.createConversationArchiveScheduler({
      store, archiveStore, fence, rawRetentionDays: 14, clock: fakeClock.read, isScopeAuthorized: (scopeId) => enabled && scopeId === authorizedScope,
      provider: { compact: async (request) => { freshBodies.push({ scopeId: request.scope.scopeId, sourceMessageIds: request.sourceEvents.map((event) => event.messageId) }); return JSON.stringify({ schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction, scopeId: request.scope.scopeId, sourceMessageIds: request.sourceEvents.map((event) => event.messageId), summary: "allowed", durableFacts: [], confidence: 1 }); } },
      timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    await fresh.ready;
    expect(freshBodies).toEqual([{ scopeId: authorizedScope, sourceMessageIds: ["allowed"] }]);

    const retry = recordOldEvent(store, "retry", authorizedScope, "100000000000000011");
    const batchKey = `archive-v1:${authorizedScope}:${retry.id}:${retry.id}`;
    expect(archiveStore.claimArchiveBatch({ batchKey, summaryKey: `archive-summary-v1:${batchKey}`, scopeId: authorizedScope, sourceStartId: retry.id, sourceEndId: retry.id, sourceEventIds: [retry.id], fence })).toBe(true);
    expect(archiveStore.retryArchiveBatch(batchKey, fence)).toBe(true);
    for (let index = 0; index < 12; index += 1) { fakeClock.advance(10_000); fence = archiveStore.renewLease(fence)!; }
    enabled = false; let revokedCalls = 0;
    const revoked = service.createConversationArchiveScheduler({ store, archiveStore, fence, rawRetentionDays: 14, clock: fakeClock.read, isScopeAuthorized: (scopeId) => enabled && scopeId === authorizedScope,
      provider: { compact: async () => { revokedCalls += 1; return "{}"; } }, timer: { setInterval: () => 0, clearInterval: () => undefined } });
    await revoked.ready;
    expect(revokedCalls).toBe(0);
    enabled = true; const retryBodies: unknown[] = [];
    const reenabled = service.createConversationArchiveScheduler({ store, archiveStore, fence, rawRetentionDays: 14, clock: fakeClock.read, isScopeAuthorized: (scopeId) => enabled && scopeId === authorizedScope,
      provider: { compact: async (request) => { retryBodies.push({ scopeId: request.scope.scopeId, sourceMessageIds: request.sourceEvents.map((event) => event.messageId) }); return JSON.stringify({ schema: service.CONVERSATION_CONTRACT_SCHEMAS.memoryCompaction, scopeId: request.scope.scopeId, sourceMessageIds: request.sourceEvents.map((event) => event.messageId), summary: "retry", durableFacts: [], confidence: 1 }); } }, timer: { setInterval: () => 0, clearInterval: () => undefined } });
    await reenabled.ready;
    expect(retryBodies).toEqual([{ scopeId: authorizedScope, sourceMessageIds: ["retry"] }]);
    db.close();
  });
});
