import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDiscordParticipantScopeAllowed, parseDiscordParticipantAllowlist, readAmbientSettings, type DiscordParticipantScope } from "./adaptive-ambient-contracts.js";
import { createAdaptiveAmbientAppraisalProvider, createConversationParticipationPrimaryProvider } from "./adaptive-ambient-provider.js";
import { createConversationParticipationValidator } from "./conversation-participation-validator.js";
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
const VALIDATOR_MODELS = new Set(["gpt-4.1-mini", "gpt-4o-mini"]);
type Env = Readonly<Record<string, string | undefined>>;
type Timer = { readonly setInterval: (callback: () => void, ms: number) => unknown; readonly clearInterval: (handle: unknown) => void };
export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogger = { readonly log: (level: WorkerLogLevel, event: string, fields: Readonly<Record<string, string | number | boolean>>) => void };
export type DiscordAmbientWorkerConfig = {
  readonly dbPath: string; readonly botToken: string; readonly providerEndpoint: string; readonly providerToken: string; readonly providerModel: string;
  readonly validatorModel: string; readonly validatorTimeoutMs: number; readonly defaultMode: "off" | "shadow" | "apply";
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
  const validatorModel = env.HENT_AI_CONVERSATION_VALIDATOR_MODEL?.trim() || "gpt-4.1-mini";
  if (!VALIDATOR_MODELS.has(validatorModel)) diagnostics.push("invalid_validator_model");
  const validatorTimeoutMs = boundedTimeout(env.HENT_AI_CONVERSATION_VALIDATOR_TIMEOUT_MS, diagnostics);
  const defaultMode = participationDefaultMode(env.HENT_AI_CONVERSATION_PARTICIPATION_DEFAULT_MODE, diagnostics);
  const pollIntervalMs = positive(env.HENT_AI_DISCORD_PARTICIPANT_POLL_INTERVAL_MS, POLL_INTERVAL_MS, diagnostics);
  if (diagnostics.length > 0 || !startup.enabled || !dbPath || !botToken || !providerEndpoint || !providerToken || !providerModel) return { diagnostics };
  return { config: { dbPath, botToken, providerEndpoint, providerToken, providerModel, validatorModel, validatorTimeoutMs, defaultMode, globalPersona: env.HENT_AI_CONVERSATION_PERSONA?.trim() || undefined, scopes: startup.allowlist, pollIntervalMs }, diagnostics };
}

export async function startDiscordAmbientWorker(env: Env = process.env, dependencies: DiscordAmbientWorkerDependencies = {}): Promise<DiscordAmbientWorker> {
  const loaded = loadDiscordAmbientWorkerConfig(env);
  const logger = dependencies.logger ?? jsonLogger;
  if (!loaded.config) { logger.log("warn", "discord_ambient_worker_disabled", { reasons: loaded.diagnostics.join(",") || "invalid_config" }); return disabled(); }
  const config = loaded.config;
  const clock = dependencies.clock ?? Date.now;
  const timer = dependencies.timer ?? nativeTimer;
  const db = (dependencies.createDatabase ?? ((path) => new ServiceDatabase(path)))(config.dbPath);
  const eligible = config.scopes.filter((scope) => validScope(db, scope) && (participationModeForScope(db, scope, config.defaultMode).mode !== "apply" || config.providerModel !== config.validatorModel));
  for (const scope of config.scopes) {
    const participation = participationModeForScope(db, scope, config.defaultMode);
    if (!participation.valid) logger.log("warn", "discord_ambient_scope_mode_invalid", scopeFields(scope, "participation_mode_invalid"));
    if (!eligible.includes(scope)) logger.log("warn", "discord_ambient_scope_skipped", scopeFields(scope, !validScope(db, scope) ? "mapping_or_profile_invalid" : "apply_validator_model_must_differ"));
  }
  if (eligible.length === 0) { db.close(); logger.log("warn", "discord_ambient_worker_disabled", { reasons: "no_enabled_scopes" }); return disabled(); }
  const store = createAdaptiveAmbientStore(db, clock);
  const holder = dependencies.holderId ?? randomUUID();
  const startupController = new AbortController();
  const providerClient = (dependencies.createProviderClient ?? createOpenAiConversationProviderClient)({ endpoint: config.providerEndpoint, token: config.providerToken, model: config.providerModel, timeoutMs: 10_000 });
  const validatorClient = (dependencies.createProviderClient ?? createOpenAiConversationProviderClient)({ endpoint: config.providerEndpoint, token: config.providerToken, model: config.validatorModel, timeoutMs: config.validatorTimeoutMs });
  const provider = createAdaptiveAmbientAppraisalProvider({ client: providerClient, model: config.providerModel });
  const primary = createConversationParticipationPrimaryProvider({ client: providerClient, model: config.providerModel });
  const validator = createConversationParticipationValidator({ client: validatorClient, model: config.validatorModel });
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
  let rejectedParticipationTransition = false;
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
    const participation = participationModeForScope(db, scope, config.defaultMode);
    if (!persistParticipationMode(db, scope, participation.mode, fence, clock())) {
      store.releaseLease(fence);
      logger.log("warn", "discord_ambient_scope_skipped", scopeFields(scope, "direct_off_to_apply_requires_shadow_promotion"));
      rejectedParticipationTransition = true;
      continue;
    }
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
  if (scopeFences.size === 0 && rejectedParticipationTransition) { db.close(); return disabled(); }
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
    const runtime = createRuntime({ serviceDb: db, store, provider, primary, validator, primaryModel: config.providerModel, validatorModel: config.validatorModel,
      startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: ambientBudgetPerHour(db, scope),
      defaultMode: config.defaultMode, globalPersona: config.globalPersona, clock, scheduleHeartbeat: (callback, ms) => { const handle = timer.setInterval(callback, ms); return () => timer.clearInterval(handle); },
      loadRoster: async (current, signal) => (await accumulateDiscordRoster(current, ({ after }) => client.fetchGuildMembers(current.guildId, after, signal).then((members) => members.map((member) => ({ userId: member.userId, bot: member.bot }))), clock())).roster });
    const delivery = (dependencies.createDelivery ?? createDiscordAmbientDelivery)({ store, client, isAuthorized: (channelId, planId) => deliveryAuthorized(config, db, scope, channelId, planId) });
    const core = (dependencies.createCore ?? createDiscordAmbientWorkerCore)({ store, client, scope, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, channelMapping: () => db.getChannelMapping(scope.channelId), holderId: holder, initialFence: fence, selfUserId: botUserId, leaseKey: leaseKey(scope), clock, scheduleHeartbeat: (callback, ms) => { const handle = timer.setInterval(callback, ms); return () => timer.clearInterval(handle); }, runWork: async ({ fence: currentFence, signal }) => {
      const participation = participationModeForScope(db, scope, config.defaultMode);
      if (!persistParticipationMode(db, scope, participation.mode, currentFence, clock())) return;
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

type ParticipationMode = "off" | "shadow" | "apply";
type ParticipationModeRead = { readonly valid: true; readonly mode: ParticipationMode } | { readonly valid: false; readonly mode: "off" };

function participationModeForScope(db: ServiceDatabase, scope: DiscordParticipantScope, defaultMode: ParticipationMode = "off"): ParticipationModeRead {
  const row = db.db.prepare("SELECT settings_json FROM channel_settings WHERE channel_id=?").get(scope.channelId) as { readonly settings_json: string | null } | undefined;
  try {
    const settings = JSON.parse(row?.settings_json ?? "{}") as { conversationParticipationMode?: unknown };
    if (settings.conversationParticipationMode === undefined) return { valid: true, mode: defaultMode };
    return settings.conversationParticipationMode === "off" || settings.conversationParticipationMode === "shadow" || settings.conversationParticipationMode === "apply"
      ? { valid: true, mode: settings.conversationParticipationMode }
      : { valid: false, mode: "off" };
  } catch { return { valid: false, mode: "off" }; }
}

function persistParticipationMode(db: ServiceDatabase, scope: DiscordParticipantScope, mode: ParticipationMode, fence: import("./adaptive-ambient-store.js").Fence, now: number): boolean {
  const sql = db.db;
  sql.exec("BEGIN IMMEDIATE");
  try {
    const current = sql.prepare("SELECT mode,changed_at_ms FROM conversation_participation_mode_state WHERE guild_id=? AND channel_id=?")
      .get(scope.guildId, scope.channelId) as { readonly mode: ParticipationMode; readonly changed_at_ms: number } | undefined;
    const fenced = sql.prepare("SELECT 1 FROM adaptive_leases WHERE lease_key=? AND holder_id=? AND fence_token=? AND expires_at_ms>?")
      .get(fence.key, fence.holderId, fence.fenceToken, now) !== undefined;
    if (!fenced) throw new Error("stale fence");
    const promoted = current?.mode === "shadow" && sql.prepare(`SELECT 1 FROM conversation_participation_ticks t
      JOIN conversation_participation_validations v ON v.tick_id=t.id
      WHERE t.guild_id=? AND t.channel_id=? AND t.mode='shadow' AND t.status='validated'
        AND v.status='accepted_shadow' AND v.updated_at_ms>=? LIMIT 1`).get(scope.guildId, scope.channelId, current.changed_at_ms) !== undefined;
    const allowed = mode === "off" || (mode === "shadow" && (current === undefined || current.mode === "off" || current.mode === "shadow" || current.mode === "apply")) || (mode === "apply" && (current?.mode === "apply" || promoted));
    if (!allowed) { sql.exec("ROLLBACK"); return false; }
    if (current === undefined) sql.prepare("INSERT INTO conversation_participation_mode_state (guild_id,channel_id,mode,changed_at_ms) VALUES (?,?,?,?)").run(scope.guildId, scope.channelId, mode, now);
    else if (current.mode !== mode) sql.prepare("UPDATE conversation_participation_mode_state SET mode=?,changed_at_ms=? WHERE guild_id=? AND channel_id=?").run(mode, now, scope.guildId, scope.channelId);
    sql.exec("COMMIT");
    return true;
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
}
function participationApplyAuthorized(db: ServiceDatabase, scope: DiscordParticipantScope): boolean {
  return db.db.prepare("SELECT 1 FROM conversation_participation_mode_state WHERE guild_id=? AND channel_id=? AND mode='apply'")
    .get(scope.guildId, scope.channelId) !== undefined;
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
function deliveryAuthorized(config: DiscordAmbientWorkerConfig, db: ServiceDatabase, scope: DiscordParticipantScope, channelId: string, planId: string): boolean {
  if (channelId !== scope.channelId || !isDiscordParticipantScopeAllowed({ enabled: true, allowlist: [scope], diagnostics: [] }, scope, db.getChannelMapping(channelId))) return false;
  const plan = db.db.prepare("SELECT decision_version FROM participant_delivery_plans WHERE id=?").get(planId) as { readonly decision_version: string } | undefined;
  if (!plan) return false;
  return plan.decision_version === "v1" || (plan.decision_version === "v2" && participationModeForScope(db, scope, config.defaultMode).mode === "apply" && participationApplyAuthorized(db, scope) && config.providerModel !== config.validatorModel);
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
function endpoint(value: string | undefined, diagnostics: string[]): string | undefined {
  const normalized = required(value, "provider_endpoint", diagnostics);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !loopbackHttp) throw new Error();
    return parsed.toString();
  } catch {
    diagnostics.push("invalid_provider_endpoint");
    return undefined;
  }
}
function positive(value: string | undefined, fallback: number, diagnostics: string[]): number { if (!value?.trim()) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1000) { diagnostics.push("invalid_poll_interval"); return fallback; } return parsed; }
function participationDefaultMode(value: string | undefined, diagnostics: string[]): "off" | "shadow" | "apply" {
  if (!value?.trim()) return "off";
  if (value === "off" || value === "shadow" || value === "apply") return value;
  diagnostics.push("participation_mode_invalid");
  return "off";
}
function boundedTimeout(value: string | undefined, diagnostics: string[]): number {
  if (!value?.trim()) return 5_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 10_000) {
    diagnostics.push("invalid_validator_timeout");
    return 5_000;
  }
  return parsed;
}
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
