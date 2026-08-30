import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as service from "./index.js";

const roots: string[] = [];
const scope = { guildId: "100000000000000001", channelId: "100000000000000002" };
function path(): string { const root = mkdtempSync(join(tmpdir(), "hent-worker-redteam-")); roots.push(root); return join(root, "service.sqlite"); }
function env(dbPath: string): Record<string, string> { return { HENT_AI_DISCORD_PARTICIPANT_ENABLED: "true", HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST: `${scope.guildId}:${scope.channelId}`, HENT_AI_SERVICE_DB_PATH: dbPath, HENT_AI_DISCORD_BOT_TOKEN: "bot-token-not-for-log", HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "https://provider.example/v1", HENT_AI_CONVERSATION_PROVIDER_TOKEN: "provider-token-not-for-log", HENT_AI_CONVERSATION_PROVIDER_MODEL: "model" }; }
function client(): service.DiscordParticipantClient { return { getCurrentUser: async () => ({ id: "100000000000000003", username: "bot", bot: true }), verifyChannelGuild: async (channelId, guildId) => ({ id: channelId, guildId }), fetchMessages: async () => [], fetchGuildMembers: async () => [], sendTyping: async () => undefined, createMessage: async () => { throw new Error("not called"); }, deleteMessage: async () => undefined }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Discord ambient worker red team", () => {
  it("takes over live archive ownership without restarting scope polling", async () => {
    const dbPath = path(); const seeded = new service.ServiceDatabase(dbPath); seeded.setChannelMapping(scope.channelId, { enabled: true }); seeded.close();
    let now = 1_000_000; const callbacks: Array<() => void> = []; let schedulers = 0; let stopped = 0; let polls = 0;
    const ownerDb = new service.ServiceDatabase(dbPath); const owner = service.createAdaptiveAmbientStore(ownerDb, () => now);
    const ownerFence = owner.acquireLease("discord-ambient-archive-worker", "owner-a");
    if (!ownerFence) throw new Error("failed to hold archive lease");
    const worker = await service.startDiscordAmbientWorker(env(dbPath), {
      clock: () => now, createClient: () => client(),
      timer: { setInterval: (callback) => { callbacks.push(callback); return callback; }, clearInterval: () => undefined },
      createScheduler: (() => { schedulers += 1; return { ready: Promise.resolve({}), run: async () => ({}), stop: () => { stopped += 1; } }; }) as never,
      createCore: (() => ({ signal: new AbortController().signal, claimNextWork: () => null, runOnce: async () => { polls += 1; return "ingested"; }, stop: async () => undefined })) as never,
    });
    expect(worker.status).toBe("running"); expect(schedulers).toBe(0);
    await worker.runOnce(); expect(polls).toBe(1);
    expect(owner.releaseLease(ownerFence)).toBe(true);
    callbacks[0]!(); await Promise.resolve();
    expect(schedulers).toBe(1);
    now += 10_000; callbacks[0]!(); await Promise.resolve();
    now += 20_001;
    expect(owner.acquireLease("discord-ambient-archive-worker", "owner-a")).toBeNull();
    now += 10_000;
    const takeover = owner.acquireLease("discord-ambient-archive-worker", "owner-a");
    if (!takeover) throw new Error("failed to take over expired archive lease");
    callbacks[0]!(); await Promise.resolve();
    expect(stopped).toBe(1);
    expect(owner.releaseLease(takeover)).toBe(true);
    callbacks[0]!(); await Promise.resolve();
    expect(schedulers).toBe(2);
    await worker.stop();
    expect(ownerDb.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases WHERE lease_key='discord-ambient-archive-worker'").get()).toEqual({ count: 0 });
    ownerDb.close();
  });

  it("stops the archive scheduler after archive-heartbeat renewal loss", async () => {
    const dbPath = path(); const db = new service.ServiceDatabase(dbPath); db.setChannelMapping(scope.channelId, { enabled: true }); db.close();
    let now = 1_000_000; const callbacks: Array<() => void> = []; let stopped = 0; const logs: unknown[] = [];
    const worker = await service.startDiscordAmbientWorker(env(dbPath), { clock: () => now, createClient: () => client(), logger: { log: (level, event, fields) => logs.push({ level, event, fields }) }, timer: { setInterval: (callback) => { callbacks.push(callback); return callback; }, clearInterval: () => undefined }, createScheduler: (() => ({ ready: Promise.resolve({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), run: async () => ({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), stop: () => { stopped += 1; } })) as never, createCore: (() => ({ signal: new AbortController().signal, claimNextWork: () => null, runOnce: async () => "ingested", stop: async () => undefined })) as never });
    now += 30_001; const contender = new service.ServiceDatabase(dbPath); const contenderStore = service.createAdaptiveAmbientStore(contender, () => now); expect(contenderStore.acquireLease("discord-ambient-archive-worker", "other")).not.toBeNull();
    callbacks[0]!();
    expect(stopped).toBe(1); expect(logs).toContainEqual(expect.objectContaining({ event: "discord_ambient_archive_lease_lost" }));
    expect(contender.db.prepare("SELECT COUNT(*) AS count FROM participant_worker_diagnostics WHERE lease_key='discord-ambient-archive-worker'").get()).toEqual({ count: 1 });
    await worker.stop(); contender.close();
  });

  it("heartbeats startup fences through identity validation and initial archive startup", async () => {
    const dbPath = path(); const seeded = new service.ServiceDatabase(dbPath); seeded.setChannelMapping(scope.channelId, { enabled: true }); seeded.close();
    let now = 1_000_000; const callbacks: Array<() => void> = []; let resolveIdentity!: (user: service.DiscordParticipantUser) => void; let resolveReady!: () => void;
    const identity = new Promise<service.DiscordParticipantUser>((resolve) => { resolveIdentity = resolve; });
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const workerStart = service.startDiscordAmbientWorker(env(dbPath), {
      clock: () => now,
      createClient: () => ({ ...client(), getCurrentUser: async () => identity }),
      timer: { setInterval: (callback) => { callbacks.push(callback); return callback; }, clearInterval: () => undefined },
      createScheduler: (() => ({ ready, run: async () => ({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), stop: () => undefined })) as never,
    });
    for (let index = 0; index < 4; index += 1) { now += 10_000; for (const callback of callbacks) callback(); }
    const contender = new service.ServiceDatabase(dbPath); const contenderStore = service.createAdaptiveAmbientStore(contender, () => now);
    expect(contenderStore.acquireLease("discord-ambient-archive-worker", "other")).toBeNull();
    expect(contenderStore.acquireLease(`discord-ambient-worker:${scope.guildId}:${scope.channelId}`, "other")).toBeNull();
    resolveIdentity({ id: "100000000000000003", username: "bot", bot: true }); resolveReady();
    const worker = await workerStart; expect(worker.status).toBe("running"); await worker.stop(); contender.close();
  });

  it("fails closed when an archive startup heartbeat renewal returns null", async () => {
    const dbPath = path(); const seeded = new service.ServiceDatabase(dbPath); seeded.setChannelMapping(scope.channelId, { enabled: true }); seeded.close();
    let now = 1_000_000; const callbacks: Array<() => void> = []; let rejectReady!: (reason?: unknown) => void; let signalSchedulerCreated!: () => void; let schedulerStopped = 0; let createdCores = 0;
    const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
    const schedulerCreated = new Promise<void>((resolve) => { signalSchedulerCreated = resolve; });
    const started = service.startDiscordAmbientWorker(env(dbPath), {
      clock: () => now, createClient: () => client(),
      timer: { setInterval: (callback) => { callbacks.push(callback); return callback; }, clearInterval: () => undefined },
      createScheduler: (() => { signalSchedulerCreated(); return { ready, run: async () => ({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), stop: () => { schedulerStopped += 1; rejectReady(new Error("startup aborted")); } }; }) as never,
      createCore: (() => { createdCores += 1; throw new Error("core must not start after lease loss"); }) as never,
    });
    await schedulerCreated; now += 30_001; callbacks[0]!();
    await expect(started).resolves.toMatchObject({ status: "disabled" });
    const check = new service.ServiceDatabase(dbPath);
    expect(schedulerStopped).toBe(1); expect(createdCores).toBe(0);
    expect(check.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 });
    expect(check.db.prepare("SELECT COUNT(*) AS count FROM participant_worker_diagnostics WHERE diagnostic='archive worker lease renewal failed'").get()).toEqual({ count: 1 });
    check.close();
  });

  it("releases startup leases when the initial archive pass rejects", async () => {
    const dbPath = path();
    const seeded = new service.ServiceDatabase(dbPath);
    seeded.setChannelMapping(scope.channelId, { enabled: true });
    seeded.close();
    const logs: unknown[] = [];

    await expect(service.startDiscordAmbientWorker(env(dbPath), {
      createClient: () => client(),
      logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
      createScheduler: (() => ({
        ready: Promise.reject(new Error("provider-token-not-for-log")),
        run: async () => ({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }),
        stop: () => undefined,
      })) as never,
    })).resolves.toMatchObject({ status: "disabled" });

    const check = new service.ServiceDatabase(dbPath);
    expect(check.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 });
    check.close();
    expect(JSON.stringify(logs)).not.toContain("token-not-for-log");
    expect(logs).toContainEqual(expect.objectContaining({ event: "discord_ambient_archive_startup_failed" }));
  });

  it("catches rejected poll cycles as sanitized structured errors and releases resources", async () => {
    const dbPath = path(); const db = new service.ServiceDatabase(dbPath); db.setChannelMapping(scope.channelId, { enabled: true }); db.close();
    const callbacks: Array<() => void> = []; const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    let resolveFailure!: () => void; const failureLogged = new Promise<void>((resolve) => { resolveFailure = resolve; });
    const worker = await service.startDiscordAmbientWorker(env(dbPath), { createClient: () => client(), logger: { log: (_level, event, fields) => { logs.push({ event, fields }); if (event === "discord_ambient_poll_cycle_failed") resolveFailure(); } }, timer: { setInterval: (callback) => { callbacks.push(callback); return callback; }, clearInterval: () => undefined }, createScheduler: (() => ({ ready: Promise.resolve({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), run: async () => ({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), stop: () => undefined })) as never, createCore: (() => ({ signal: new AbortController().signal, claimNextWork: async () => null, runOnce: async () => { throw new Error("bot-token-not-for-log provider-token-not-for-log"); }, stop: async () => undefined })) as never });
    callbacks.at(-1)!(); await failureLogged;
    expect(logs).toContainEqual(expect.objectContaining({ event: "discord_ambient_poll_cycle_failed", fields: { reason: "poll_cycle_failed" } }));
    expect(JSON.stringify(logs)).not.toContain("token-not-for-log");
    await worker.stop(); const check = new service.ServiceDatabase(dbPath); expect(check.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases WHERE lease_key='discord-ambient-archive-worker'").get()).toEqual({ count: 0 }); check.close();
  });

  it("returns a nonzero startup result without leaking startup failure content", async () => {
    const lines: string[] = [];
    await expect(service.runDiscordAmbientWorker(async () => { throw new Error("bot-token-not-for-log"); }, (line) => lines.push(line))).resolves.toBe(1);
    expect(lines).toEqual([JSON.stringify({ event: "discord_ambient_worker_startup_failed" })]);
  });
});
