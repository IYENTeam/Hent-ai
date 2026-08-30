import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as service from "./index.js";

type Clock = { now: number; advance: (ms: number) => void };
type Worker = { runOnce: () => Promise<string>; stop: () => Promise<void>; claimNextWork: () => string | null };
type Factory = (input: Record<string, unknown>) => Worker;
const roots: string[] = [];
const scope = { guildId: "100", channelId: "200" };
const startup = { enabled: true, allowlist: [scope], diagnostics: [] };

function clock(start = 1_000_000): Clock { let now = start; return { get now() { return now; }, advance: (ms) => { now += ms; } }; }
function path(): string { const root = mkdtempSync(join(tmpdir(), "hent-worker-")); roots.push(root); return join(root, "worker.sqlite"); }
function api(): Factory { const candidate: unknown = Reflect.get(service, "createDiscordAmbientWorkerCore"); expect(typeof candidate, "queues cursor-forward worker work once").toBe("function"); return candidate as Factory; }
function message(id: string, createdAtMs: number, options: Partial<{ bot: boolean; authorId: string; content: string }> = {}): Record<string, unknown> {
  return { id, channelId: scope.channelId, content: options.content ?? `message-${id}`, timestamp: new Date(createdAtMs).toISOString(), author: { id: options.authorId ?? "300", username: "author", bot: options.bot ?? false } };
}
function client(fetchMessages: (after: string | undefined, signal?: AbortSignal) => Promise<readonly Record<string, unknown>[]>): Record<string, unknown> {
  return { fetchMessages: (channelId: string, page: { after?: string }, signal?: AbortSignal) => { expect(channelId).toBe(scope.channelId); return fetchMessages(page.after, signal); } };
}
function worker(input: Record<string, unknown>): Worker { return api()(input); }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("fenced Discord ambient worker core", () => {
  it("seeds first boot, ingests ascending forward events atomically, preserves self evidence, and classifies the exact age boundary", async () => {
    const fake = clock(); const db = new service.ServiceDatabase(path()); const store = service.createAdaptiveAmbientStore(db, () => fake.now);
    const first = worker({ store, client: client(async () => [message("3", fake.now)]), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "first", clock: () => fake.now });
    expect(await first.runOnce()).toBe("seeded");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM participant_event_work").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT message_id FROM participant_poll_cursors").get()).toEqual({ message_id: "3" });
    await first.stop();

    const second = worker({ store, client: client(async (after) => { expect(after).toBe("3"); return [message("6", fake.now, { bot: true, authorId: "999" }), message("5", fake.now - 600_001), message("4", fake.now - 600_000)]; }), scope, startup, channelMapping: () => ({ enabled: true }), selfUserId: "999", holderId: "second", clock: () => fake.now });
    expect(await second.runOnce()).toBe("ingested");
    expect(db.db.prepare("SELECT message_id,author_role,bot_self_loop FROM conversation_raw_events ORDER BY message_id").all()).toEqual([
      { message_id: "4", author_role: "user", bot_self_loop: 0 }, { message_id: "5", author_role: "user", bot_self_loop: 0 }, { message_id: "6", author_role: "assistant", bot_self_loop: 1 },
    ]);
    expect(db.db.prepare("SELECT event_id,observe_only FROM participant_event_work ORDER BY event_id").all()).toEqual([{ event_id: "4", observe_only: 0 }, { event_id: "5", observe_only: 1 }]);
    expect(db.db.prepare("SELECT message_id FROM participant_poll_cursors").get()).toEqual({ message_id: "6" });
    expect(second.claimNextWork()).toBe("discord:100:200:4");
    fake.advance(30_001); await second.stop();
    const recovery = worker({ store, client: client(async () => []), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "recovery", clock: () => fake.now });
    expect(await recovery.runOnce()).toBe("ingested");
    expect(recovery.claimNextWork()).toBe("discord:100:200:4");
    await recovery.stop(); db.close();
  });

  it("leaves the cursor unchanged when raw/work ingestion fails and rejects replay digest conflicts", async () => {
    const fake = clock(); const db = new service.ServiceDatabase(path()); const store = service.createAdaptiveAmbientStore(db, () => fake.now);
    const seed = worker({ store, client: client(async () => [message("1", fake.now)]), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "seed", clock: () => fake.now });
    await seed.runOnce(); await seed.stop();
    db.db.exec("CREATE TRIGGER reject_work BEFORE INSERT ON participant_event_work BEGIN SELECT RAISE(FAIL, 'forced ingress failure'); END");
    const failed = worker({ store, client: client(async () => [message("2", fake.now)]), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "failed", clock: () => fake.now });
    await expect(failed.runOnce()).rejects.toThrow("forced ingress failure");
    expect(db.db.prepare("SELECT message_id FROM participant_poll_cursors").get()).toEqual({ message_id: "1" });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM conversation_raw_events").get()).toEqual({ count: 0 });
    await failed.stop(); db.db.exec("DROP TRIGGER reject_work");
    const created = worker({ store, client: client(async () => [message("2", fake.now)]), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "created", clock: () => fake.now });
    expect(await created.runOnce()).toBe("ingested"); await created.stop();
    const row = db.db.prepare("SELECT event_digest FROM participant_event_work WHERE event_id='2'").get() as { event_digest: string };
    const raw = db.db.prepare("SELECT metadata_json FROM conversation_raw_events WHERE message_id='2'").get() as { metadata_json: string };
    const replayFence = store.acquireLease("replay", "replay")!;
    const replay = { eventId: "2", eventDigest: row.event_digest, observeOnly: false, queue: true, raw: { scopeId: "discord:100:200", channelId: "200", messageId: "2", authorRole: "user" as const, text: "message-2", eventTs: new Date(fake.now).toISOString(), botSelfLoop: false, metadata: JSON.parse(raw.metadata_json) } };
    expect(() => store.ingestForwardEvents({ scope, cursor: "2", fence: replayFence, events: [replay] })).not.toThrow();
    expect(() => store.ingestForwardEvents({ scope, cursor: "2", fence: replayFence, events: [{ ...replay, eventDigest: "conflict" }] })).toThrow("event digest conflict");
    store.releaseLease(replayFence); db.close();
  });

  it("uses a 10s same-token heartbeat, two real connections, and an abort ledger to fence post-loss dispatch", async () => {
    const fake = clock(); const databasePath = path(); const firstDb = new service.ServiceDatabase(databasePath); const secondDb = new service.ServiceDatabase(databasePath);
    const firstStore = service.createAdaptiveAmbientStore(firstDb, () => fake.now); const secondStore = service.createAdaptiveAmbientStore(secondDb, () => fake.now);
    const seed = firstStore.acquireLease("discord-ambient-worker", "seed")!; expect(firstStore.setCursor(scope, "1", seed)).toBe(true); firstStore.releaseLease(seed);
    const calls: string[] = []; let heartbeat: (() => void) | undefined; let releaseProvider: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let markProviderStarted: (() => void) | undefined;
    const enteredProvider = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const a = worker({ store: firstStore, client: client(async (_after, signal) => { calls.push("fetch"); signal?.addEventListener("abort", () => calls.push("abort"), { once: true }); return [message("2", fake.now)]; }), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "a", clock: () => fake.now, scheduleHeartbeat: (run: () => void, intervalMs: number) => { expect(intervalMs).toBe(10_000); heartbeat = run; return () => { calls.push("heartbeat-cancelled"); }; }, runWork: async ({ signal }: { signal: AbortSignal }) => { calls.push("provider"); markProviderStarted?.(); await providerStarted; if (signal.aborted) return; calls.push("typing"); calls.push("send"); } });
    const pending = a.runOnce(); await enteredProvider;
    const tokenBefore = firstDb.db.prepare("SELECT fence_token FROM adaptive_leases WHERE lease_key='discord-ambient-worker'").get();
    fake.advance(10_000); expect(heartbeat).toBeTypeOf("function"); heartbeat!();
    expect(firstDb.db.prepare("SELECT fence_token FROM adaptive_leases WHERE lease_key='discord-ambient-worker'").get()).toEqual(tokenBefore);
    const b = worker({ store: secondStore, client: client(async () => []), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "b", clock: () => fake.now });
    expect(await b.runOnce()).toBe("lease_unavailable");
    fake.advance(30_001); expect(await b.runOnce()).toBe("ingested");
    heartbeat!(); releaseProvider?.();
    expect(await pending).toBe("aborted");
    expect(calls).toEqual(["fetch", "provider", "abort", "heartbeat-cancelled"]);
    await a.stop();
    expect(secondDb.db.prepare("SELECT holder_id FROM adaptive_leases WHERE lease_key='discord-ambient-worker'").get()).toEqual({ holder_id: "b" });
    await b.stop();
    expect(secondDb.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 });
    firstDb.close(); secondDb.close();
  });

  it("does not fetch or ingest when the configured allowlist and DB enablement intersection is false", async () => {
    const fake = clock(); const db = new service.ServiceDatabase(); const store = service.createAdaptiveAmbientStore(db, () => fake.now); let fetched = false;
    const disabled = worker({ store, client: client(async () => { fetched = true; return []; }), scope, startup, channelMapping: () => ({ enabled: false }), holderId: "disabled", clock: () => fake.now });
    expect(await disabled.runOnce()).toBe("disabled"); expect(fetched).toBe(false);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM conversation_raw_events").get()).toEqual({ count: 0 });
    await disabled.stop(); db.close();
  });

  it("aborts an active fetch before waiting and releases its lease without a post-stop work boundary", async () => {
    const fake = clock(); const db = new service.ServiceDatabase(path()); const store = service.createAdaptiveAmbientStore(db, () => fake.now);
    const seed = store.acquireLease("seed", "seed")!; expect(store.setCursor(scope, "1", seed)).toBe(true); store.releaseLease(seed);
    let subscribed!: () => void; let aborted!: () => void; let workCalls = 0;
    const fetchSubscribed = new Promise<void>((resolve) => { subscribed = resolve; });
    const fetchAborted = new Promise<void>((resolve) => { aborted = resolve; });
    const active = worker({ store, client: client(async (_after, signal) => new Promise((resolve) => {
      subscribed(); signal?.addEventListener("abort", () => { aborted(); resolve([]); }, { once: true });
    })), scope, startup, channelMapping: () => ({ enabled: true }), holderId: "stop", clock: () => fake.now,
      runWork: async () => { workCalls += 1; } });
    void active.runOnce();
    await fetchSubscribed;
    const stopping = active.stop();
    await fetchAborted;
    await stopping;
    expect(workCalls).toBe(0);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 });
    db.close();
  });
});
