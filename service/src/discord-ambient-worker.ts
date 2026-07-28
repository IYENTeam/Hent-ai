import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDiscordParticipantScopeAllowed, parseDiscordParticipantAllowlist, readAmbientSettings, type DiscordParticipantScope } from "./adaptive-ambient-contracts.js";
import { createAdaptiveAmbientAppraisalProvider } from "./adaptive-ambient-provider.js";
import { createAdaptiveAmbientRuntime } from "./adaptive-ambient-runtime.js";
import { createAdaptiveAmbientStore, type AdaptiveAmbientStore } from "./adaptive-ambient-store.js";
import { createConversationArchiveScheduler } from "./conversation-archive-scheduler.js";
import { createDiscordAmbientArchiveOwner } from "./discord-ambient-archive-owner.js";
import { ConversationStore } from "./conversation-store.js";
import { createOpenAiConversationProviderClient, type ConversationProviderClient } from "./conversation-provider-client.js";
import { accumulateDiscordRoster } from "./conversation-roster.js";
import { ServiceDatabase } from "./db.js";
import { createDiscordAmbientDelivery } from "./discord-ambient-delivery.js";
import { createDiscordAmbientWorkerCore, type DiscordAmbientWorkerCore } from "./discord-ambient-worker-core.js";
import { createDiscordParticipantClient, type DiscordParticipantClient } from "./discord-participant-client.js";

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_AMBIENT_BUDGET_PER_HOUR = 20;
type Env = Readonly<Record<string, string | undefined>>;
type Timer = { readonly setInterval: (callback: () => void, ms: number) => unknown; readonly clearInterval: (handle: unknown) => void };
export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogger = { readonly log: (level: WorkerLogLevel, event: string, fields: Readonly<Record<string, string | number | boolean>>) => void };
export type DiscordAmbientWorkerConfig = {
  readonly dbPath: string; readonly botToken: string; readonly providerEndpoint: string; readonly providerToken: string; readonly providerModel: string;
  readonly globalPersona?: string; readonly scopes: readonly DiscordParticipantScope[]; readonly pollIntervalMs: number;
};
export type DiscordAmbientWorker = { readonly status: "disabled" | "running"; readonly stop: () => Promise<void>; readonly runOnce: () => Promise<void> };

export type DiscordAmbientWorkerDependencies = {
  readonly createDatabase?: (path: string) => ServiceDatabase;
  readonly createClient?: (token: string) => DiscordParticipantClient;
  /** Test composition can inject a loopback provider client without relaxing HTTPS env validation. */
  readonly createProviderClient?: (config: { readonly endpoint: string; readonly token: string; readonly model: string; readonly timeoutMs: number }) => ConversationProviderClient;
  readonly createDelivery?: typeof createDiscordAmbientDelivery;
  readonly createRuntime?: typeof createAdaptiveAmbientRuntime;
  readonly createCore?: typeof createDiscordAmbientWorkerCore;
  readonly createScheduler?: typeof createConversationArchiveScheduler;
  readonly timer?: Timer;
  readonly clock?: () => number;
  readonly logger?: WorkerLogger;
  readonly holderId?: string;
};

export function loadDiscordAmbientWorkerConfig(env: Env = process.env): { readonly config?: DiscordAmbientWorkerConfig; readonly diagnostics: readonly string[] } {
  const diagnostics: string[] = [];
  if (env.HENT_AI_DISCORD_PARTICIPANT_ENABLED?.trim().toLowerCase() !== "true") diagnostics.push("participant_not_enabled");
  const startup = parseDiscordParticipantAllowlist(env.HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST);
  if (!startup.enabled) diagnostics.push("invalid_allowlist");
  const dbPath = required(env.HENT_AI_SERVICE_DB_PATH, "db_path", diagnostics);
  const botToken = required(env.HENT_AI_DISCORD_BOT_TOKEN, "bot_token", diagnostics);
  const providerEndpoint = endpoint(env.HENT_AI_CONVERSATION_PROVIDER_ENDPOINT, diagnostics);
  const providerToken = required(env.HENT_AI_CONVERSATION_PROVIDER_TOKEN, "provider_token", diagnostics);
  const providerModel = required(env.HENT_AI_CONVERSATION_PROVIDER_MODEL, "provider_model", diagnostics);
  const pollIntervalMs = positive(env.HENT_AI_DISCORD_PARTICIPANT_POLL_INTERVAL_MS, POLL_INTERVAL_MS, diagnostics);
  if (diagnostics.length > 0 || !startup.enabled || !dbPath || !botToken || !providerEndpoint || !providerToken || !providerModel) return { diagnostics };
  return { config: { dbPath, botToken, providerEndpoint, providerToken, providerModel, globalPersona: env.HENT_AI_CONVERSATION_PERSONA?.trim() || undefined, scopes: startup.allowlist, pollIntervalMs }, diagnostics };
}

export async function startDiscordAmbientWorker(env: Env = process.env, dependencies: DiscordAmbientWorkerDependencies = {}): Promise<DiscordAmbientWorker> {
  const loaded = loadDiscordAmbientWorkerConfig(env);
  const logger = dependencies.logger ?? jsonLogger;
  if (!loaded.config) { logger.log("warn", "discord_ambient_worker_disabled", { reasons: loaded.diagnostics.join(",") || "invalid_config" }); return disabled(); }
  const config = loaded.config;
  const clock = dependencies.clock ?? Date.now;
  const timer = dependencies.timer ?? nativeTimer;
  const db = (dependencies.createDatabase ?? ((path) => new ServiceDatabase(path)))(config.dbPath);
  const eligible = config.scopes.filter((scope) => validScope(db, scope));
  for (const scope of config.scopes) if (!eligible.includes(scope)) logger.log("warn", "discord_ambient_scope_skipped", scopeFields(scope, "mapping_or_profile_invalid"));
  if (eligible.length === 0) { db.close(); logger.log("warn", "discord_ambient_worker_disabled", { reasons: "no_enabled_scopes" }); return disabled(); }
  const store = createAdaptiveAmbientStore(db, clock);
  const holder = dependencies.holderId ?? randomUUID();
  const startupController = new AbortController();
  const providerClient = (dependencies.createProviderClient ?? createOpenAiConversationProviderClient)({ endpoint: config.providerEndpoint, token: config.providerToken, model: config.providerModel, timeoutMs: 10_000 });
  const provider = createAdaptiveAmbientAppraisalProvider({ client: providerClient, model: config.providerModel });
  const archiveOwner = createDiscordAmbientArchiveOwner({
    store, holderId: holder, timer,
    createScheduler: (fence, signal) => (dependencies.createScheduler ?? createConversationArchiveScheduler)({ store: new ConversationStore(db), archiveStore: store,
      provider: { compact: async (request) => { const result = await providerClient.complete(request.prompt, { signal }); return result.kind === "ok" ? result.content : null; } },
      fence, rawRetentionDays: 14, clock, signal, isScopeAuthorized: (scopeId) => archiveScopeAuthorized(config, db, scopeId),
      onError: () => logger.log("error", "discord_ambient_archive_cycle_failed", { reason: "archive_cycle_failed" }) }),
    onLeaseLost: () => logger.log("warn", "discord_ambient_archive_lease_lost", { reason: "renewal_failed" }),
    onSchedulerFailure: () => logger.log("error", "discord_ambient_archive_startup_failed", { reason: "archive_startup_failed" }),
  });
  const scopeFences = new Map<string, import("./adaptive-ambient-store.js").Fence>();
  const scopeHeartbeats = new Map<string, unknown>();
  const cancelStartupHeartbeats = (): void => {
    for (const heartbeat of scopeHeartbeats.values()) timer.clearInterval(heartbeat);
    scopeHeartbeats.clear();
  };
  const loseStartupFence = (fence: import("./adaptive-ambient-store.js").Fence, reason: string): void => {
    if (startupController.signal.aborted) return;
    store.recordUnfencedDiagnostic(fence, reason);
    startupController.abort(new Error(reason));
    archiveOwner.stop();
    cancelStartupHeartbeats();
  };
  for (const scope of [...eligible].sort(compareScope)) {
    const key = leaseKey(scope); const fence = store.acquireLease(key, holder);
    if (!fence) { logger.log("warn", "discord_ambient_scope_skipped", scopeFields(scope, "lease_unavailable")); continue; }
    scopeFences.set(key, fence);
    scopeHeartbeats.set(key, timer.setInterval(() => {
      const current = scopeFences.get(key);
      try {
        const renewed = current ? store.renewLease(current) : null;
        if (renewed) { scopeFences.set(key, renewed); return; }
      } catch { /* fail closed below */ }
      if (current) loseStartupFence(current, "discord worker startup lease renewal failed");
    }, 10_000));
  }
  const startArchive = async (): Promise<boolean> => {
    if (await archiveOwner.activate() && !startupController.signal.aborted) return true;
    cancelStartupHeartbeats();
    for (const fence of scopeFences.values()) store.releaseLease(fence);
    archiveOwner.stop();
    db.close();
    logger.log("error", "discord_ambient_archive_startup_failed", { reason: "archive_startup_failed" });
    return false;
  };
  if (scopeFences.size === 0) {
    if (!await startArchive()) return disabled();
    return standby(archiveOwner.stop, db.close.bind(db));
  }
  const createClient: (token: string) => DiscordParticipantClient = dependencies.createClient ?? ((token) => createDiscordParticipantClient({ token }));
  const client = createClient(config.botToken);
  let botUserId: string;
  try {
    if (startupController.signal.aborted) throw new Error("startup lease renewal failed");
    botUserId = (await client.getCurrentUser(startupController.signal)).id;
    if (startupController.signal.aborted) throw new Error("startup lease renewal failed");
    for (const scope of eligible) if (scopeFences.has(leaseKey(scope))) {
      await client.verifyChannelGuild(scope.channelId, scope.guildId, startupController.signal);
      if (startupController.signal.aborted) throw new Error("startup lease renewal failed");
    }
  } catch {
    cancelStartupHeartbeats();
    for (const fence of scopeFences.values()) store.releaseLease(fence);
    archiveOwner.stop();
    db.close(); logger.log("error", "discord_ambient_worker_disabled", { reasons: "discord_identity_or_scope_validation_failed" }); return disabled();
  }
  if (!await startArchive()) return disabled();
  const cores: DiscordAmbientWorkerCore[] = [];
  const createRuntime = dependencies.createRuntime ?? createAdaptiveAmbientRuntime;
  for (const scope of [...eligible].sort(compareScope)) {
    const key = leaseKey(scope); const fence = scopeFences.get(key);
    if (!fence || startupController.signal.aborted) continue;
    const startupHeartbeat = scopeHeartbeats.get(key);
    if (startupHeartbeat !== undefined) timer.clearInterval(startupHeartbeat);
    scopeHeartbeats.delete(key);
    const runtime = createRuntime({ serviceDb: db, store, provider, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: ambientBudgetPerHour(db, scope),
      globalPersona: config.globalPersona, clock, scheduleHeartbeat: (callback, ms) => { const handle = timer.setInterval(callback, ms); return () => timer.clearInterval(handle); },
      loadRoster: async (current, signal) => (await accumulateDiscordRoster(current, ({ after }) => client.fetchGuildMembers(current.guildId, after, signal).then((members) => members.map((member) => ({ userId: member.userId, bot: member.bot }))), clock())).roster });
    const delivery = (dependencies.createDelivery ?? createDiscordAmbientDelivery)({ store, client, isAuthorized: (channelId) => channelId === scope.channelId && isDiscordParticipantScopeAllowed({ enabled: true, allowlist: [scope], diagnostics: [] }, scope, db.getChannelMapping(channelId)) });
    const core = (dependencies.createCore ?? createDiscordAmbientWorkerCore)({ store, client, scope, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, channelMapping: () => db.getChannelMapping(scope.channelId), holderId: holder, initialFence: fence, selfUserId: botUserId, leaseKey: leaseKey(scope), clock, scheduleHeartbeat: (callback, ms) => { const handle = timer.setInterval(callback, ms); return () => timer.clearInterval(handle); }, runWork: async ({ fence: currentFence, signal }) => {
      for (const planId of pendingPlanIds(store, scope)) await delivery.deliver({ planId, fence: currentFence, signal });
      const result = await runtime.run({ fence: currentFence, signal });
      if (result === "planned") for (const planId of pendingPlanIds(store, scope)) await delivery.deliver({ planId, fence: currentFence, signal });
    } });
    cores.push(core); logger.log("info", "discord_ambient_scope_started", scopeFields(scope, "ready"));
  }
  if (cores.length === 0) { archiveOwner.stop(); db.close(); return disabled(); }
  let active: Promise<void> | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  const runOnce = async (): Promise<void> => { if (active) return active; active = (async () => { for (const core of cores) await core.runOnce(); })().finally(() => { active = null; }); return active; };
  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      timer.clearInterval(handle);
      archiveOwner.stop();
      const coreStops = cores.map((core) => core.stop());
      if (active) await active.catch(() => undefined);
      await Promise.all(coreStops);
      db.close();
    })();
    return stopPromise;
  };
  const handle = timer.setInterval(() => {
    if (stopped) return;
    void runOnce().catch(() => { logger.log("error", "discord_ambient_poll_cycle_failed", { reason: "poll_cycle_failed" }); void stop(); });
  }, config.pollIntervalMs);
  return { status: "running", runOnce, stop };
}

function validScope(db: ServiceDatabase, scope: DiscordParticipantScope): boolean { const mapping = db.getChannelMapping(scope.channelId); return mapping?.enabled === true && (!mapping.profileId || db.getProfile(mapping.profileId) !== null); }
function ambientBudgetPerHour(db: ServiceDatabase, scope: DiscordParticipantScope): number {
  const row = db.db.prepare("SELECT settings_json FROM channel_settings WHERE channel_id=?").get(scope.channelId) as { readonly settings_json: string | null } | undefined;
  return readAmbientSettings(row?.settings_json ?? null).ambientBudgetPerHour ?? DEFAULT_AMBIENT_BUDGET_PER_HOUR;
}
function archiveScopeAuthorized(config: DiscordAmbientWorkerConfig, db: ServiceDatabase, scopeId: string): boolean {
  const scope = config.scopes.find((candidate) => scopeId === `discord:${candidate.guildId}:${candidate.channelId}`);
  return scope !== undefined && isDiscordParticipantScopeAllowed({ enabled: true, allowlist: config.scopes, diagnostics: [] }, scope, db.getChannelMapping(scope.channelId));
}
function standby(stopArchive: () => void, closeDb: () => void): DiscordAmbientWorker {
  let stopped = false;
  return { status: "running", runOnce: async () => undefined, stop: async () => { if (!stopped) { stopped = true; stopArchive(); closeDb(); } } };
}
function pendingPlanIds(store: AdaptiveAmbientStore, scope: DiscordParticipantScope): readonly string[] { return store.pendingDeliveryPlanIds(scope); }
function leaseKey(scope: DiscordParticipantScope): string { return `discord-ambient-worker:${scope.guildId}:${scope.channelId}`; }
function compareScope(a: DiscordParticipantScope, b: DiscordParticipantScope): number { return `${a.guildId}:${a.channelId}`.localeCompare(`${b.guildId}:${b.channelId}`); }
function scopeFields(scope: DiscordParticipantScope, reason: string): Record<string, string> { return { guildId: scope.guildId, channelId: scope.channelId, reason }; }
function required(value: string | undefined, reason: string, diagnostics: string[]): string | undefined { const normalized = value?.trim(); if (!normalized) diagnostics.push(`missing_${reason}`); return normalized; }
function endpoint(value: string | undefined, diagnostics: string[]): string | undefined { const normalized = required(value, "provider_endpoint", diagnostics); if (!normalized) return undefined; try { const parsed = new URL(normalized); if (parsed.protocol !== "https:") throw new Error(); return parsed.toString(); } catch { diagnostics.push("invalid_provider_endpoint"); return undefined; } }
function positive(value: string | undefined, fallback: number, diagnostics: string[]): number { if (!value?.trim()) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1000) { diagnostics.push("invalid_poll_interval"); return fallback; } return parsed; }
function disabled(): DiscordAmbientWorker { return { status: "disabled", runOnce: async () => undefined, stop: async () => undefined }; }
const nativeTimer: Timer = { setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout) };
const jsonLogger: WorkerLogger = { log: (level, event, fields) => console[level](JSON.stringify({ event, ...fields })) };

export const DISCORD_AMBIENT_WORKER_HELP = "Usage: hent-ai-discord-ambient-worker [--help]";

export async function main(): Promise<void> { const worker = await startDiscordAmbientWorker(); const stop = async () => { await worker.stop(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }; process.on("SIGINT", stop); process.on("SIGTERM", stop); }
export async function runDiscordAmbientWorker(start: () => Promise<void> = main, log: (line: string) => void = console.error): Promise<number> {
  try { await start(); return 0; } catch { log(JSON.stringify({ event: "discord_ambient_worker_startup_failed" })); return 1; }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${DISCORD_AMBIENT_WORKER_HELP}\n`);
  } else {
    void runDiscordAmbientWorker().then((exitCode) => { process.exitCode = exitCode; });
  }
}
