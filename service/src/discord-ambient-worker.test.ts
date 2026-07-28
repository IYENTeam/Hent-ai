import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as service from "./index.js";

const roots: string[] = [];
const scopes = [
  { guildId: "100000000000000001", channelId: "100000000000000011" },
  { guildId: "100000000000000002", channelId: "100000000000000012" },
];

function path(): string { const root = mkdtempSync(join(tmpdir(), "hent-ambient-entry-")); roots.push(root); return join(root, "service.sqlite"); }
function env(dbPath: string, allowlist = scopes): Record<string, string> {
  return {
    HENT_AI_DISCORD_PARTICIPANT_ENABLED: "true", HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST: allowlist.map((scope) => `${scope.guildId}:${scope.channelId}`).join(","),
    HENT_AI_SERVICE_DB_PATH: dbPath, HENT_AI_DISCORD_BOT_TOKEN: "bot-token", HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "https://provider.example/v1/chat/completions",
    HENT_AI_CONVERSATION_PROVIDER_TOKEN: "provider-token", HENT_AI_CONVERSATION_PROVIDER_MODEL: "test-model",
  };
}
function client(): service.DiscordParticipantClient {
  return {
    getCurrentUser: async () => ({ id: "100000000000000099", username: "bot", bot: true }),
    verifyChannelGuild: async (channelId, guildId) => ({ id: channelId, guildId }), fetchMessages: async () => [], fetchGuildMembers: async () => [],
    sendTyping: async () => undefined, createMessage: async () => ({ id: "100000000000000088", channelId: "100000000000000011", content: "", timestamp: new Date().toISOString(), author: { id: "100000000000000099", username: "bot", bot: true }, mentions: [], replyTo: null }), deleteMessage: async () => undefined,
  };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Discord ambient worker entrypoint", () => {
  it("fails closed before opening a database or Discord client", async () => {
    expect(service.loadDiscordAmbientWorkerConfig({ ...env(path()), HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST: "malformed" }).config).toBeUndefined();
    expect(service.loadDiscordAmbientWorkerConfig({ ...env(path()), HENT_AI_CONVERSATION_PROVIDER_ENDPOINT: "http://provider.example" }).config).toBeUndefined();
    let opened = 0; let clientCreated = 0; const events: unknown[] = [];
    const worker = await service.startDiscordAmbientWorker({}, {
      createDatabase: () => { opened += 1; throw new Error("must not open"); }, createClient: () => { clientCreated += 1; throw new Error("must not connect"); },
      logger: { log: (_level, event, fields) => events.push({ event, fields }) },
    });
    expect(worker.status).toBe("disabled");
    expect(opened).toBe(0); expect(clientCreated).toBe(0);
    expect(events).toEqual([{ event: "discord_ambient_worker_disabled", fields: { reasons: "participant_not_enabled,invalid_allowlist,missing_db_path,missing_bot_token,missing_provider_endpoint,missing_provider_token,missing_provider_model" } }]);
  });

  it("starts archive scheduling before the scope core polls", async () => {
    const dbPath = path(); const db = new service.ServiceDatabase(dbPath); db.setChannelMapping(scopes[0]!.channelId, { enabled: true }); db.close();
    const order: string[] = [];
    const worker = await service.startDiscordAmbientWorker(env(dbPath, [scopes[0]!]), {
      createClient: () => client(),
      createScheduler: (() => { order.push("archive"); return { ready: Promise.resolve({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), run: async () => ({ claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 }), stop: () => undefined }; }) as never,
      createCore: (() => ({ signal: new AbortController().signal, claimNextWork: () => null, runOnce: async () => { order.push("poll"); return "ingested"; }, stop: async () => undefined })) as never,
      timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    await worker.runOnce();
    expect(order).toEqual(["archive", "poll"]);
    await worker.stop();
  });

  it("owns each configured scope once and skips missing DB mappings", async () => {
    const dbPath = path(); const db = new service.ServiceDatabase(dbPath);
    for (const scope of scopes) db.setChannelMapping(scope.channelId, { enabled: true });
    db.close();
    const timer = { setInterval: () => 0, clearInterval: () => undefined };
    const first = await service.startDiscordAmbientWorker(env(dbPath), { createClient: () => client(), timer });
    expect(first.status).toBe("running");
    const second = await service.startDiscordAmbientWorker(env(dbPath), { createClient: () => client(), timer });
    expect(second.status).toBe("running");
    const active = new service.ServiceDatabase(dbPath);
    expect(active.db.prepare("SELECT lease_key FROM adaptive_leases ORDER BY lease_key").all()).toEqual([
      { lease_key: "discord-ambient-archive-worker" }, { lease_key: `discord-ambient-worker:${scopes[0]!.guildId}:${scopes[0]!.channelId}` }, { lease_key: `discord-ambient-worker:${scopes[1]!.guildId}:${scopes[1]!.channelId}` },
    ]);
    active.close(); await second.stop(); await first.stop();
    const released = new service.ServiceDatabase(dbPath);
    expect(released.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 }); released.close();

    const missingPath = path(); const mapped = new service.ServiceDatabase(missingPath); mapped.setChannelMapping(scopes[0]!.channelId, { enabled: true }); mapped.close();
    const missing = await service.startDiscordAmbientWorker(env(missingPath), { createClient: () => client(), timer });
    expect(missing.status).toBe("running"); await missing.stop();
  });

  it("does not call Discord identity or polling when every eligible scope lease is unavailable", async () => {
    const dbPath = path();
    const ownerDb = new service.ServiceDatabase(dbPath);
    ownerDb.setChannelMapping(scopes[0]!.channelId, { enabled: true });
    const ownerStore = service.createAdaptiveAmbientStore(ownerDb, () => 1_000_000);
    const ownerFence = ownerStore.acquireLease(`discord-ambient-worker:${scopes[0]!.guildId}:${scopes[0]!.channelId}`, "other-worker");
    if (!ownerFence) throw new Error("failed to hold scope lease");
    const handles = new Set<object>();
    let identityCalls = 0; let verifyCalls = 0; let pollCalls = 0; let typingCalls = 0; let sendCalls = 0;
    const worker = await service.startDiscordAmbientWorker(env(dbPath, [scopes[0]!]), {
      clock: () => 1_000_000,
      createClient: () => ({ ...client(), getCurrentUser: async () => { identityCalls += 1; return { id: "100000000000000099", username: "bot", bot: true }; },
        verifyChannelGuild: async (channelId, guildId) => { verifyCalls += 1; return { id: channelId, guildId }; },
        fetchMessages: async () => { pollCalls += 1; return []; }, sendTyping: async () => { typingCalls += 1; },
        createMessage: async () => { sendCalls += 1; throw new Error("must not send"); } }),
      createScheduler: (() => ({ ready: Promise.resolve({}), run: async () => ({}), stop: () => undefined })) as never,
      timer: { setInterval: () => { const handle = {}; handles.add(handle); return handle; }, clearInterval: (handle) => { handles.delete(handle as object); } },
    });
    expect(worker.status).toBe("running");
    await worker.runOnce();
    expect({ identityCalls, verifyCalls, pollCalls, typingCalls, sendCalls }).toEqual({ identityCalls: 0, verifyCalls: 0, pollCalls: 0, typingCalls: 0, sendCalls: 0 });
    expect(ownerStore.releaseLease(ownerFence)).toBe(true);
    await worker.stop();
    expect(handles).toEqual(new Set());
    expect(ownerDb.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 });
    ownerDb.close();
  });

  it("composes each scope runtime with its channel budget override", async () => {
    const dbPath = path(); const db = new service.ServiceDatabase(dbPath);
    db.setChannelMapping(scopes[0]!.channelId, { enabled: true, settings: { ambientBudgetPerHour: 3 } }); db.close();
    let budgetPerHour: number | undefined;
    const worker = await service.startDiscordAmbientWorker(env(dbPath, [scopes[0]!]), {
      createClient: () => client(),
      createRuntime: ((options: { readonly budgetPerHour: number }) => { budgetPerHour = options.budgetPerHour; return { run: async () => "idle" }; }) as never,
      createCore: (() => ({ signal: new AbortController().signal, claimNextWork: () => null, runOnce: async () => "ingested", stop: async () => undefined })) as never,
      timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    expect(budgetPerHour).toBe(3);
    await worker.stop();
  });

  it("injects exact dynamic Discord archive authorization", async () => {
    const dbPath = path(); const db = new service.ServiceDatabase(dbPath);
    db.setChannelMapping(scopes[0]!.channelId, { enabled: true }); db.close();
    let authorize: ((scopeId: string) => boolean) | undefined;
    const worker = await service.startDiscordAmbientWorker(env(dbPath, [scopes[0]!]), {
      createClient: () => client(),
      createScheduler: ((options: { readonly isScopeAuthorized?: (scopeId: string) => boolean }) => {
        authorize = options.isScopeAuthorized;
        return { ready: Promise.resolve({}), run: async () => ({}), stop: () => undefined };
      }) as never,
      timer: { setInterval: () => 0, clearInterval: () => undefined },
    });
    expect(authorize?.(`discord:${scopes[0]!.guildId}:${scopes[0]!.channelId}`)).toBe(true);
    expect(authorize?.(`discord:${scopes[1]!.guildId}:${scopes[1]!.channelId}`)).toBe(false);
    expect(authorize?.(scopes[0]!.channelId)).toBe(false);
    const reopened = new service.ServiceDatabase(dbPath);
    reopened.setChannelMapping(scopes[0]!.channelId, { enabled: false });
    expect(authorize?.(`discord:${scopes[0]!.guildId}:${scopes[0]!.channelId}`)).toBe(false);
    reopened.setChannelMapping(scopes[0]!.channelId, { enabled: true });
    expect(authorize?.(`discord:${scopes[0]!.guildId}:${scopes[0]!.channelId}`)).toBe(true);
    reopened.close(); await worker.stop();
  });

  it("aborts an active poll before waiting, clears timers, and releases leases on worker stop", async () => {
    const dbPath = path(); const seeded = new service.ServiceDatabase(dbPath); seeded.setChannelMapping(scopes[0]!.channelId, { enabled: true });
    const seededStore = service.createAdaptiveAmbientStore(seeded, () => 1_000_000); const seedFence = seededStore.acquireLease("seed", "seed")!;
    expect(seededStore.setCursor(scopes[0]!, "1", seedFence)).toBe(true); seededStore.releaseLease(seedFence); seeded.close();
    let started!: () => void; let aborted!: () => void; let sends = 0; let providerCalls = 0; let archiveStops = 0;
    const pollStarted = new Promise<void>((resolve) => { started = resolve; }); const pollAborted = new Promise<void>((resolve) => { aborted = resolve; });
    const handles = new Set<object>();
    const worker = await service.startDiscordAmbientWorker(env(dbPath, [scopes[0]!]), {
      clock: () => 1_000_000,
      createClient: () => ({ ...client(), fetchMessages: async (_channel, _page, signal) => new Promise<readonly service.DiscordParticipantMessage[]>((resolve) => {
        started(); signal?.addEventListener("abort", () => { aborted(); resolve([]); }, { once: true });
      }), sendTyping: async () => { sends += 1; }, createMessage: async () => { sends += 1; throw new Error("must not send"); } }),
      createProviderClient: (() => ({ complete: async () => { providerCalls += 1; return { kind: "invalid", diagnostic: "must not call" } as const; } })) as never,
      createScheduler: (() => ({ ready: Promise.resolve({}), run: async () => ({}), stop: () => { archiveStops += 1; } })) as never,
      timer: { setInterval: () => { const handle = {}; handles.add(handle); return handle; }, clearInterval: (handle) => { handles.delete(handle as object); } },
    });
    const running = worker.runOnce(); await pollStarted;
    const stopping = worker.stop(); await pollAborted; await stopping; await running;
    expect({ sends, providerCalls, archiveStops }).toEqual({ sends: 0, providerCalls: 0, archiveStops: 1 });
    expect(handles).toEqual(new Set());
    const check = new service.ServiceDatabase(dbPath);
    expect(check.db.prepare("SELECT COUNT(*) AS count FROM adaptive_leases").get()).toEqual({ count: 0 }); check.close();
  });
});
