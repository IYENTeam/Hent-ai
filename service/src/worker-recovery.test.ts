import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceDatabase } from "./db.js";
import { createAdaptiveAmbientStore } from "./adaptive-ambient-store.js";
import { createDiscordAmbientWorkerCore } from "./discord-ambient-worker-core.js";
import { ConversationStore } from "./conversation-store.js";
import { createConversationArchiveScheduler } from "./conversation-archive-scheduler.js";

const scope = { guildId: "100", channelId: "200" };
const startup = { enabled: true, allowlist: [scope], diagnostics: [] };
const databases: ServiceDatabase[] = [];
function database() { const db = new ServiceDatabase(); databases.push(db); return db; }
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

describe("worker recovery and drain", () => {
  it("persists empty initialization across cores and ingests the first human message", async () => {
    const db = database(); const store = createAdaptiveAmbientStore(db, () => 1_000_000);
    const options = { store, scope, startup, channelMapping: () => ({ enabled: true }), holderId: "worker", clock: () => 1_000_000, scheduleHeartbeat: () => () => undefined };
    const first = createDiscordAmbientWorkerCore({ ...options, client: { fetchMessages: async () => [] } });
    expect(await first.runOnce()).toBe("seeded");
    expect(store.cursor(scope)).toBe("0");
    await first.stop();
    const next = createDiscordAmbientWorkerCore({ ...options, client: { fetchMessages: async () => [{ id: "2", channelId: "200", content: "hello", timestamp: new Date(1_000_000).toISOString(), author: { id: "300", bot: false, username: "human" }, mentions: [], replyTo: null }] } });
    expect(await next.runOnce()).toBe("ingested");
    expect(db.db.prepare("SELECT event_id FROM participant_event_work").all()).toEqual([{ event_id: "2" }]);
    await next.stop();
  });

  it("recovers a lost lease with a fresh signal after prior work drains", async () => {
    const db = database(); let now = 1_000_000;
    const store = createAdaptiveAmbientStore(db, () => now);
    let heartbeat!: () => void;
    const core = createDiscordAmbientWorkerCore({ store, scope, startup, channelMapping: () => ({ enabled: true }), holderId: "worker", clock: () => now,
      scheduleHeartbeat: (callback) => { heartbeat = callback; return () => undefined; }, client: { fetchMessages: async () => [] } });
    await core.runOnce(); const originalSignal = core.signal;
    now += 30_001; heartbeat();
    expect(originalSignal.aborted).toBe(true);
    expect(await core.runOnce()).toBe("ingested");
    expect(core.signal).not.toBe(originalSignal);
    expect(core.signal.aborted).toBe(false);
    expect(originalSignal.aborted).toBe(true);
    await core.stop();
    expect(await core.runOnce()).toBe("aborted");
  });

  it("releases the lease even if aborted active work rejects", async () => {
    const db = database(); const store = createAdaptiveAmbientStore(db, () => 1_000_000);
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    const core = createDiscordAmbientWorkerCore({ store, scope, startup, channelMapping: () => ({ enabled: true }), holderId: "worker",
      scheduleHeartbeat: () => () => undefined, client: { fetchMessages: async () => [] },
      runWork: ({ signal }) => new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered(); }) });
    await core.runOnce();
    const pending = core.runOnce().catch(() => undefined); await ready;
    await expect(core.stop()).rejects.toThrow("discord worker stopped"); await pending;
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 });
  });

  it("waits for archive work on stop and never queries the database after stopping", async () => {
    const db = database(); const store = new ConversationStore(db); const archiveStore = createAdaptiveAmbientStore(db, () => Date.now());
    store.recordRawEvent({ scopeId: "c1", channelId: "c1", messageId: "m1", authorRole: "user", authorSource: "test", text: "old", eventTs: "2020-01-01T00:00:00.000Z" });
    const fence = archiveStore.acquireLease("archive", "worker")!;
    let finish!: (value: null) => void; let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const scheduler = createConversationArchiveScheduler({ store, archiveStore, fence, rawRetentionDays: 14, clock: Date.now,
      provider: { compact: async () => { entered(); return new Promise<null>((resolve) => { finish = resolve; }); } },
      timer: { setInterval: () => 0, clearInterval: () => undefined } });
    await ready; let drained = false;
    const stop = scheduler.stop().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    finish(null); await stop;
    const read = vi.spyOn(store, "listClaimableArchiveBatches");
    await scheduler.run(); expect(read).not.toHaveBeenCalled();
  });
});
