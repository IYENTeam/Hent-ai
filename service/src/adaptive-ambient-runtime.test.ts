import { afterEach, describe, expect, it, vi } from "vitest";
import * as service from "./index.js";
import { ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS, type DiscordInboundMessage, type DiscordMembershipSnapshot } from "./adaptive-ambient-contracts.js";

type Runtime = { run: (input: { readonly fence: service.Fence; readonly signal: AbortSignal }) => Promise<string> };
type RuntimeFactory = (options: Record<string, unknown>) => Runtime;
const scope = { guildId: "100000000000000001", channelId: "100000000000000002" };
const botUserId = "100000000000000003";
let now = 1_000_000;

function runtimeFactory(): RuntimeFactory | null {
  const candidate = service as object;
  return "createAdaptiveAmbientRuntime" in candidate && typeof Reflect.get(candidate, "createAdaptiveAmbientRuntime") === "function"
    ? Reflect.get(candidate, "createAdaptiveAmbientRuntime") as RuntimeFactory : null;
}

function roster(currentScope = scope): DiscordMembershipSnapshot {
  return { scope: currentScope, memberIds: ["100000000000000004", "100000000000000005"], complete: true, observedAtMs: now };
}

function provider(result: unknown, calls: string[]): { appraise: () => Promise<unknown> } {
  return { appraise: async () => { calls.push("provider"); return result; } };
}

function latch<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function appraisal(overrides: Record<string, unknown> = {}): object {
  return { kind: "valid", proposal: {
    schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal, decision: "speak", desiredDrive: 1, confidence: 1,
    chunks: ["A defiant but useful point."], relationshipProposals: [{ userId: "100000000000000004", rapportDelta: 0.1, familiarityDelta: 0, notes: ["Asked for silence."] }],
    ...overrides,
  } };
}

function auditEvidence(db: service.ServiceDatabase): { readonly evidenceWeight: number | null; readonly probability: number | null; readonly draw: number | null; readonly driveBefore: number | null; readonly driveAfter: number | null; readonly activeHumanCount: number | null; readonly rosterFresh: number | null } {
  return db.db.prepare(`SELECT evidence_weight AS evidenceWeight,probability,draw,drive_before AS driveBefore,drive_after AS driveAfter,
    active_human_count AS activeHumanCount,roster_fresh AS rosterFresh FROM adaptive_ambient_audits`).get() as {
    readonly evidenceWeight: number | null; readonly probability: number | null; readonly draw: number | null; readonly driveBefore: number | null; readonly driveAfter: number | null; readonly activeHumanCount: number | null; readonly rosterFresh: number | null;
  };
}

function setup(options: { readonly enabled?: boolean; readonly allowlisted?: boolean; readonly budgetPerHour?: number; readonly settings?: unknown; readonly result?: unknown; readonly scope?: typeof scope; readonly eventId?: string } = {}) {
  const currentScope = options.scope ?? scope;
  const eventId = options.eventId ?? "event-1";
  const db = new service.ServiceDatabase();
  db.setChannelMapping(currentScope.channelId, { enabled: options.enabled ?? true, settings: options.settings });
  const store = service.createAdaptiveAmbientStore(db, () => now);
  const fence = store.acquireLease("discord-ambient-worker", "runtime")!;
  store.createWork({ id: "work-1", eventId, eventDigest: `digest:${eventId}`, scope: currentScope });
  db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
    VALUES (?, ?, NULL, NULL, ?, 'user', 'discord-participant', ?, ?, ?, 0, ?, ?)`)
    .run(`discord:${currentScope.guildId}:${currentScope.channelId}`, currentScope.channelId, eventId, "please be quiet", new Date(now).toISOString(), new Date(now).toISOString(), JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false, mentions: [botUserId] }), new Date(now).toISOString());
  const calls: string[] = [];
  const runtime = runtimeFactory()?.({ serviceDb: db, store, provider: provider(options.result ?? appraisal(), calls), startup: { enabled: options.allowlisted !== false, allowlist: options.allowlisted === false ? [] : [currentScope], diagnostics: [] }, scope: currentScope, botUserId, budgetPerHour: options.budgetPerHour ?? 2, clock: () => now, loadRoster: async () => roster(currentScope) });
  return { db, store, fence, calls, runtime, scope: currentScope };
}

afterEach(() => { now = 1_000_000; vi.restoreAllMocks(); });

describe("atomic adaptive ambient runtime", () => {
  it("commits adaptive outcome atomically", async () => {
    const fixture = setup();
    expect(runtimeFactory()).not.toBeNull();
    expect(typeof fixture.runtime?.run).toBe("function");
    expect("dispatch" in fixture.runtime!).toBe(false);
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("planned");
    expect(fixture.calls).toEqual(["provider"]);
    expect(fixture.store.counts()).toEqual({ audits: 1, states: 1, budgets: 1, relationships: 1, plans: 1 });
    expect(fixture.db.db.prepare("SELECT status FROM participant_event_work WHERE id='work-1'").get()).toEqual({ status: "planned" });
    expect(fixture.db.db.prepare("SELECT count FROM adaptive_budgets").get()).toEqual({ count: 1 });
    expect(fixture.db.db.prepare("SELECT content FROM participant_delivery_chunks").get()).toEqual({ content: "A defiant but useful point." });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("idle");
    expect(fixture.calls).toEqual(["provider"]);
    fixture.db.close();
  });

  it("records full decision evidence in audits", async () => {
    const planned = setup();
    await expect(planned.runtime!.run({ fence: planned.fence, signal: new AbortController().signal })).resolves.toBe("planned");
    const plannedAudit = auditEvidence(planned.db);
    expect(plannedAudit).toEqual({
      evidenceWeight: 1, probability: 1, draw: service.stableAmbientDraw(`${scope.guildId}:${scope.channelId}`, "event-1"),
      driveBefore: 0.7, driveAfter: 0.7 * 0.75 + 1 * 0.25, activeHumanCount: 1, rosterFresh: 1,
    });
    if (plannedAudit.driveBefore === null || plannedAudit.driveAfter === null) throw new Error("planned audit must retain drive evidence");
    expect(service.calculateNextAmbientDrive({ scope, drive: plannedAudit.driveBefore, version: 0, updatedAtMs: now }, 1)).toBeCloseTo(plannedAudit.driveAfter, 12);
    expect(planned.store.recordOutcome({
      fence: planned.fence, eventId: "event-1", scope, outcome: "planned", workId: "work-1",
    })).toBe("idempotent");
    expect(planned.store.counts().audits).toBe(1);
    planned.db.close();

    const observed = setup({ result: appraisal({ decision: "observe", desiredDrive: 0.8, chunks: [] }) });
    await expect(observed.runtime!.run({ fence: observed.fence, signal: new AbortController().signal })).resolves.toBe("observe");
    expect(auditEvidence(observed.db)).toEqual({
      evidenceWeight: 1, probability: 0, draw: service.stableAmbientDraw(`${scope.guildId}:${scope.channelId}`, "event-1"),
      driveBefore: 0.7, driveAfter: 0.7 * 0.75 + 0.8 * 0.25, activeHumanCount: 1, rosterFresh: 1,
    });
    observed.db.close();

    const invalid = setup({ result: { kind: "invalid", diagnostic: "malformed provider result" } });
    await expect(invalid.runtime!.run({ fence: invalid.fence, signal: new AbortController().signal })).resolves.toBe("invalid");
    expect(auditEvidence(invalid.db)).toEqual({
      evidenceWeight: 1, probability: 0, draw: null, driveBefore: null, driveAfter: null, activeHumanCount: 1, rosterFresh: 1,
    });
    invalid.db.close();
  });

  it("leaves provider-unavailable work claimed for a later retry without writing an outcome", async () => {
    let result: unknown = { kind: "unavailable", diagnostic: "provider request failed" };
    const db = new service.ServiceDatabase();
    db.setChannelMapping(scope.channelId, { enabled: true });
    const store = service.createAdaptiveAmbientStore(db, () => now);
    let fence = store.acquireLease("discord-ambient-worker", "runtime")!;
    store.createWork({ id: "work-1", eventId: "event-1", eventDigest: "digest:event-1", scope });
    db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
      VALUES (?, ?, NULL, NULL, ?, 'user', 'discord-participant', ?, ?, ?, 0, ?, ?)`)
      .run(`discord:${scope.guildId}:${scope.channelId}`, scope.channelId, "event-1", "anything", new Date(now).toISOString(), new Date(now).toISOString(), JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false, mentions: [botUserId] }), new Date(now).toISOString());
    const calls: string[] = [];
    const options = { serviceDb: db, store, provider: { appraise: async () => { calls.push("provider"); return result; } }, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() };
    const runtime = runtimeFactory()!(options);

    await expect(runtime.run({ fence, signal: new AbortController().signal })).resolves.toBe("provider_unavailable");
    expect(store.counts()).toEqual({ audits: 0, states: 0, budgets: 0, relationships: 0, plans: 0 });
    expect(db.db.prepare("SELECT status FROM participant_event_work WHERE id='work-1'").get()).toEqual({ status: "claimed" });

    now += 30_001;
    fence = store.acquireLease("discord-ambient-worker", "runtime")!;
    result = appraisal();
    await expect(runtime.run({ fence, signal: new AbortController().signal })).resolves.toBe("planned");
    expect(calls).toHaveLength(2);
    db.close();
  });

  it("blocks provider dispatch on allowlist, channel, budget, lease, and abort gates", async () => {
    for (const options of [{ allowlisted: false }, { enabled: false }, { budgetPerHour: 0 }]) {
      const fixture = setup(options);
      await fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal });
      expect(fixture.calls).toEqual([]); fixture.db.close();
    }
    const budgeted = setup({ budgetPerHour: 1 });
    budgeted.db.db.prepare("INSERT INTO adaptive_budgets (scope_key,budget_key,count,window_start_ms,updated_at_ms) VALUES (?, 'ambient', 1, ?, ?)").run(`${scope.guildId}:${scope.channelId}`, 0, now);
    await budgeted.runtime!.run({ fence: budgeted.fence, signal: new AbortController().signal });
    expect(budgeted.calls).toEqual([]); budgeted.db.close();
    const aborted = setup(); const controller = new AbortController(); controller.abort();
    await expect(aborted.runtime!.run({ fence: aborted.fence, signal: controller.signal })).resolves.toBe("aborted");
    expect(aborted.calls).toEqual([]); aborted.db.close();
    const stale = setup(); now += 30_001;
    await expect(stale.runtime!.run({ fence: stale.fence, signal: new AbortController().signal })).resolves.toBe("lease_unavailable");
    expect(stale.calls).toEqual([]); stale.db.close();
  });

  it("passes actual audience values to the provider request", async () => {
    const fixture = setup();
    fixture.db.db.prepare(`INSERT INTO adaptive_ambient_state (guild_id,channel_id,drive,version,updated_at_ms)
      VALUES (?, ?, ?, ?, ?)`).run(scope.guildId, scope.channelId, 0.8, 4, now - 1);
    fixture.db.db.prepare("INSERT INTO adaptive_budgets (scope_key,budget_key,count,window_start_ms,updated_at_ms) VALUES (?, 'ambient', 1, ?, ?)")
      .run(`${scope.guildId}:${scope.channelId}`, 0, now);
    let audience: unknown;
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: { appraise: async (request: { readonly audience?: unknown }) => {
      audience = request.audience;
      return appraisal();
    } }, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });

    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("planned");
    expect(audience).toEqual({ rosterComplete: true, currentDrive: 0.8, budgetRemaining: 1 });
    fixture.db.close();
  });

  it("persists unchanged streaks for a valid provider observe", async () => {
    const fixture = setup({ result: appraisal({ decision: "observe", desiredDrive: 0.8, chunks: [] }) });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("observe");
    expect(fixture.store.state(scope)).toEqual({ drive: 0.7 * 0.75 + 0.8 * 0.25, version: 1, updatedAtMs: now, pressure: 0, pressureUpdatedAtMs: now, speakStreak: 0, skipStreak: 0 });
    expect(fixture.store.counts()).toEqual({ audits: 1, states: 1, budgets: 0, relationships: 1, plans: 0 });
    expect(fixture.db.db.prepare("SELECT status FROM participant_event_work WHERE id='work-1'").get()).toEqual({ status: "observe" });
    fixture.db.close();
  });

  it("uses the persisted state timestamp when relaxing drive after idle time", async () => {
    const fixture = setup();
    const tauMs = 2 * 3_600_000;
    fixture.db.db.prepare(`INSERT INTO adaptive_ambient_state (guild_id,channel_id,drive,version,updated_at_ms)
      VALUES (?, ?, ?, ?, ?)`).run(scope.guildId, scope.channelId, 1, 4, now - tauMs);

    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("planned");
    expect(fixture.store.state(scope)).toEqual({
      drive: 0.625 + 0.375 * Math.exp(-1),
      version: 5,
      updatedAtMs: now,
      pressure: 0,
      pressureUpdatedAtMs: now,
      speakStreak: 1,
      skipStreak: 0,
    });
    fixture.db.close();
  });

  it("honors scoped decay and pressure settings end-to-end", async () => {
    const eventId = Array.from({ length: 100 }, (_, index) => `settings-${index}`).find((candidate) => {
      const draw = service.stableAmbientDraw(`${scope.guildId}:${scope.channelId}`, candidate);
      return draw > 0.6 && draw < 0.9;
    });
    if (!eventId) throw new Error("could not select a deterministic ambient draw");
    const fixture = setup({ eventId, settings: { ambientIdleDecayTauMs: 60_000, ambientPressureTauMs: 60_000 }, result: appraisal({ desiredDrive: 0.1 }) });
    fixture.db.db.prepare(`INSERT INTO adaptive_ambient_state (guild_id,channel_id,drive,version,updated_at_ms,pressure,pressure_updated_at_ms,speak_streak,skip_streak)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope.guildId, scope.channelId, 1, 4, now - 60_000, 0.5, now - 60_000, 0, 4);

    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("planned");
    const decayedDrive = 0.5 + 0.5 * Math.exp(-1);
    const decayedPressure = 0.5 * Math.exp(-1);
    expect(fixture.store.state(scope)).toEqual({
      drive: decayedDrive * 0.75 + (0.1 * (1 - decayedPressure)) * 0.25,
      version: 5,
      updatedAtMs: now,
      pressure: decayedPressure,
      pressureUpdatedAtMs: now,
      speakStreak: 1,
      skipStreak: 0,
    });
    fixture.db.close();
  });

  it("does not read channel-A or legacy guild relationship profiles in channel B", async () => {
    const otherScope = { guildId: scope.guildId, channelId: "100000000000000006" };
    const fixture = setup({ scope: otherScope, result: appraisal({ decision: "observe", chunks: [] }) });
    fixture.db.db.prepare(`INSERT INTO adaptive_relationship_profiles (guild_id,channel_id,user_id,rapport,familiarity,notes_json,updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(scope.guildId, scope.channelId, "100000000000000004", 0.9, 0.8, '["channel A"]', now);
    fixture.db.db.prepare(`INSERT INTO adaptive_relationship_profiles (guild_id,channel_id,user_id,rapport,familiarity,notes_json,updated_at_ms)
      VALUES (?, '', ?, ?, ?, ?, ?)`)
      .run(scope.guildId, "100000000000000005", 0.7, 0.6, '["legacy"]', now);
    let relationships: unknown;
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: { appraise: async (request: { readonly context?: { readonly relationships: unknown } }) => {
      relationships = request.context?.relationships;
      return appraisal({ decision: "observe", chunks: [] });
    } }, startup: { enabled: true, allowlist: [otherScope], diagnostics: [] }, scope: otherScope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster(otherScope) });

    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("observe");
    expect(relationships).toEqual([]);
    fixture.db.close();
  });

  it("accepts provider confidence at the global default floor", async () => {
    const fixture = setup({ result: appraisal({ confidence: 0.65 }) });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("planned");
    expect(fixture.store.counts()).toEqual({ audits: 1, states: 1, budgets: 1, relationships: 1, plans: 1 });
    fixture.db.close();
  });

  it("re-reads the scoped confidence floor when work begins", async () => {
    const fixture = setup({ settings: { ambientConfidenceFloor: 0.6 }, result: appraisal({ confidence: 0.65 }) });
    fixture.db.setChannelMapping(scope.channelId, { enabled: true, settings: { ambientConfidenceFloor: 0.7 } });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("invalid");
    expect(fixture.store.counts()).toEqual({ audits: 1, states: 0, budgets: 0, relationships: 0, plans: 0 });
    fixture.db.close();
  });

  it("keeps invalid provider output audit-only and turns provider exceptions into typed invalid outcomes", async () => {
    const invalid = setup({ result: { kind: "invalid", diagnostic: "malformed provider result" } });
    await expect(invalid.runtime!.run({ fence: invalid.fence, signal: new AbortController().signal })).resolves.toBe("invalid");
    expect(invalid.store.counts()).toEqual({ audits: 1, states: 0, budgets: 0, relationships: 0, plans: 0 }); invalid.db.close();
    const lowConfidence = setup({ result: appraisal({ confidence: 0.59 }) });
    await expect(lowConfidence.runtime!.run({ fence: lowConfidence.fence, signal: new AbortController().signal })).resolves.toBe("invalid");
    expect(lowConfidence.store.counts()).toEqual({ audits: 1, states: 0, budgets: 0, relationships: 0, plans: 0 }); lowConfidence.db.close();
    const thrown = setup();
    thrown.runtime = runtimeFactory()?.({ serviceDb: thrown.db, store: thrown.store, provider: { appraise: async () => { thrown.calls.push("provider"); throw new Error("provider failure"); } }, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(thrown.runtime!.run({ fence: thrown.fence, signal: new AbortController().signal })).resolves.toBe("provider_unavailable");
    expect(thrown.store.counts()).toEqual({ audits: 0, states: 0, budgets: 0, relationships: 0, plans: 0 }); thrown.db.close();
  });

  it("preserves only complete reply metadata in runtime transcript context", async () => {
    for (const replyTo of [undefined, null, { messageId: "600000000000000001", authorId: "100000000000000003" }]) {
      const fixture = setup({ result: appraisal({ decision: "observe", chunks: [] }) });
      fixture.db.db.prepare("UPDATE conversation_raw_events SET metadata_json=? WHERE message_id='event-1'")
        .run(JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false, mentions: [], ...(replyTo === undefined ? {} : { replyTo }) }));
      let transcript: readonly DiscordInboundMessage[] = [];
      fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: { appraise: async (request: { readonly transcript: readonly DiscordInboundMessage[] }) => { transcript = request.transcript; return appraisal({ decision: "observe", chunks: [] }); } }, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
      await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("observe");
      expect(transcript).toHaveLength(1);
      expect(transcript[0]?.replyTo).toEqual(replyTo && typeof replyTo === "object" ? replyTo : null);
      fixture.db.close();
    }
  });

  it("does not commit after abort between provider completion and the fenced transition", async () => {
    const fixture = setup(); const controller = new AbortController();
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: { appraise: async () => { fixture.calls.push("provider"); controller.abort(); return appraisal(); } }, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: controller.signal })).resolves.toBe("aborted");
    expect(fixture.store.counts()).toEqual({ audits: 0, states: 0, budgets: 0, relationships: 0, plans: 0 }); fixture.db.close();
  });

  it("rechecks the current mapping immediately after roster load and before provider dispatch", async () => {
    const fixture = setup(); const rosterLoad = latch<DiscordMembershipSnapshot>(); const loaded = latch<void>();
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: provider(appraisal(), fixture.calls), startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2,
      clock: () => now, loadRoster: async () => { loaded.resolve(); return rosterLoad.promise; } });
    const pending = fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal });
    await loaded.promise;
    fixture.db.setChannelMapping(scope.channelId, { enabled: false });
    rosterLoad.resolve(roster());
    await expect(pending).resolves.toBe("disabled");
    expect(fixture.calls).toEqual([]);
    expect(fixture.store.counts()).toEqual({ audits: 0, states: 0, budgets: 0, relationships: 0, plans: 0 });
    fixture.db.close();
  });

  it("renews claimed work through roster and provider latches, but aborts if renewal stops", async () => {
    const renewed = setup(); const rosterLoad = latch<DiscordMembershipSnapshot>(); const providerLoad = latch<unknown>();
    let heartbeat: (() => void) | undefined;
    renewed.runtime = runtimeFactory()?.({ serviceDb: renewed.db, store: renewed.store, provider: { appraise: async () => { renewed.calls.push("provider"); return providerLoad.promise; } }, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2,
      clock: () => now, loadRoster: async () => rosterLoad.promise, scheduleHeartbeat: (run: () => void, intervalMs: number) => { expect(intervalMs).toBe(10_000); heartbeat = run; return () => undefined; } });
    const pending = renewed.runtime!.run({ fence: renewed.fence, signal: new AbortController().signal });
    for (let index = 0; index < 4; index += 1) { now += 10_000; renewed.store.renewLease(renewed.fence); heartbeat!(); }
    rosterLoad.resolve(roster());
    await Promise.resolve();
    for (let index = 0; index < 4; index += 1) { now += 10_000; renewed.store.renewLease(renewed.fence); heartbeat!(); }
    providerLoad.resolve(appraisal());
    await expect(pending).resolves.toBe("planned");
    expect(renewed.calls).toEqual(["provider"]);
    expect(renewed.store.counts()).toEqual({ audits: 1, states: 1, budgets: 1, relationships: 1, plans: 1 });
    heartbeat!();
    expect(renewed.db.db.prepare("SELECT claim_expires_at_ms FROM participant_event_work WHERE id='work-1'").get()).toEqual({ claim_expires_at_ms: null });
    renewed.db.close();

    const expired = setup(); const stalledRoster = latch<DiscordMembershipSnapshot>();
    expired.runtime = runtimeFactory()?.({ serviceDb: expired.db, store: expired.store, provider: provider(appraisal(), expired.calls), startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2,
      clock: () => now, loadRoster: async () => stalledRoster.promise, scheduleHeartbeat: () => () => undefined });
    const staleRun = expired.runtime!.run({ fence: expired.fence, signal: new AbortController().signal });
    now += 30_001; expired.store.renewLease(expired.fence); stalledRoster.resolve(roster());
    await expect(staleRun).resolves.toBe("aborted");
    expect(expired.calls).toEqual([]);
    expect(expired.store.counts()).toEqual({ audits: 0, states: 0, budgets: 0, relationships: 0, plans: 0 });
    expired.db.close();

    const lost = setup(); let lostHeartbeat: (() => void) | undefined;
    lost.runtime = runtimeFactory()?.({ serviceDb: lost.db, store: lost.store, provider: provider(appraisal(), lost.calls), startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2,
      clock: () => now, loadRoster: async (_scope: unknown, signal: AbortSignal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(roster()), { once: true })),
      scheduleHeartbeat: (run: () => void) => { lostHeartbeat = run; return () => undefined; } });
    const lostRun = lost.runtime!.run({ fence: lost.fence, signal: new AbortController().signal });
    now += 30_001; lostHeartbeat!();
    await expect(lostRun).resolves.toBe("aborted");
    expect(lost.calls).toEqual([]);
    expect(lost.store.counts()).toEqual({ audits: 0, states: 0, budgets: 0, relationships: 0, plans: 0 });
    lost.db.close();
  });
  it("keeps validator failure independent and feeds an applied prior to the immediate next V2 primary", async () => {
    const fixture = setup({ settings: { conversationParticipationMode: "apply" } });
    const priors: number[] = [];
    const primary = { decide: async (request: { readonly prior: { readonly speak: number } }) => {
      priors.push(request.prior.speak);
      return { kind: "valid" as const, proposal: { schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary, decision: "speak" as const,
        baselineDecision: "speak" as const, judgmentClass: "definitive" as const, semanticMargin: 1, priorApplied: false, confidence: 1, chunks: ["v2 reply"] } };
    } };
    let validatorAvailable = false;
    const validator = { validate: async () => validatorAvailable
      ? { kind: "valid" as const, proposal: { schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationValidator, missedOpportunity: 0, interruption: 0, confidence: 1, priorDelta: 0.05, rationale: "good" } }
      : { kind: "unavailable" as const, diagnostic: "validator unavailable" } };
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: provider(appraisal(), fixture.calls), primary, validator,
      primaryModel: "primary-model", validatorModel: "validator-model",
      startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("planned");
    const firstPlan = fixture.db.db.prepare("SELECT id FROM participant_delivery_plans WHERE decision_version='v2'").get() as { id: string };
    expect(fixture.store.cancelDelivery(firstPlan.id, fixture.fence)).toBe(true);
    fixture.db.db.prepare("UPDATE adaptive_budgets SET count=2 WHERE scope_key=? AND budget_key='ambient'").run(`${scope.guildId}:${scope.channelId}`);
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("provider_unavailable");
    expect(fixture.db.db.prepare("SELECT model FROM conversation_participation_validations").get()).toEqual({ model: "validator-model" });
    const firstTick = fixture.db.db.prepare("SELECT id,persona_revision FROM conversation_participation_ticks").get() as { id: string; persona_revision: string };
    expect(fixture.store.participationPrior(scope, firstTick.persona_revision, ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary)).toBe(0);
    now += 30_001;
    const recoveredFence = fixture.store.acquireLease("discord-ambient-worker", "runtime")!;
    validatorAvailable = true;
    await expect(fixture.runtime!.run({ fence: recoveredFence, signal: new AbortController().signal })).resolves.toBe("observe");
    const prior = fixture.db.db.prepare("SELECT value FROM conversation_participation_priors").get() as { value: number };
    expect(prior.value).toBe(0.05);

    fixture.store.createWork({ id: "work-2", eventId: "event-2", eventDigest: "digest:event-2", scope });
    fixture.db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
      VALUES (?, ?, NULL, NULL, ?, 'user', 'discord-participant', ?, ?, ?, 0, ?, ?)`)
      .run(`discord:${scope.guildId}:${scope.channelId}`, scope.channelId, "event-2", "new turn", new Date(now).toISOString(), new Date(now).toISOString(), JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false, mentions: [] }), new Date(now).toISOString());
    fixture.db.db.prepare("UPDATE adaptive_budgets SET count=0 WHERE scope_key=? AND budget_key='ambient'").run(`${scope.guildId}:${scope.channelId}`);
    await expect(fixture.runtime!.run({ fence: recoveredFence, signal: new AbortController().signal })).resolves.toBe("planned");
    expect(priors).toEqual([0, 0.05]);
    fixture.db.close();
  });
  it("keeps shadow calibration running when the apply delivery budget is exhausted", async () => {
    const fixture = setup({ settings: { conversationParticipationMode: "shadow" } });
    fixture.db.db.prepare("INSERT INTO adaptive_budgets (scope_key,budget_key,count,window_start_ms,updated_at_ms) VALUES (?, 'ambient', 2, ?, ?)").run(`${scope.guildId}:${scope.channelId}`, Math.floor(now / 3_600_000) * 3_600_000, now);
    let primaryCalls = 0;
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: provider(appraisal(), fixture.calls),
      primary: { decide: async () => {
        primaryCalls += 1;
        return { kind: "valid" as const, proposal: { schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary, decision: "observe" as const, baselineDecision: "observe" as const, judgmentClass: "definitive" as const, semanticMargin: 1, priorApplied: false, confidence: 1, chunks: [] } };
      } },
      validator: { validate: async () => ({ kind: "unavailable" as const, diagnostic: "unused" }) },
      primaryModel: "primary-model", validatorModel: "validator-model",
      startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("idle");
    expect(primaryCalls).toBe(1);
    expect(fixture.db.db.prepare("SELECT status FROM conversation_participation_ticks").get()).toEqual({ status: "decided" });
    fixture.db.close();
  });
  it("reports observe when a speak result loses the result-time budget race", async () => {
    const fixture = setup({ settings: { conversationParticipationMode: "apply" } });
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: provider(appraisal(), fixture.calls),
      primary: { decide: async () => {
        fixture.db.db.prepare("INSERT INTO adaptive_budgets (scope_key,budget_key,count,window_start_ms,updated_at_ms) VALUES (?, 'ambient', 2, ?, ?)").run(`${scope.guildId}:${scope.channelId}`, Math.floor(now / 3_600_000) * 3_600_000, now);
        return { kind: "valid" as const, proposal: { schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary, decision: "speak" as const, baselineDecision: "speak" as const, judgmentClass: "definitive" as const, semanticMargin: 1, priorApplied: false, confidence: 1, chunks: ["race loser"] } };
      } },
      validator: { validate: async () => ({ kind: "unavailable" as const, diagnostic: "unused" }) },
      primaryModel: "primary-model", validatorModel: "validator-model",
      startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("observe");
    expect(fixture.db.db.prepare("SELECT COUNT(*) AS count FROM participant_delivery_plans WHERE decision_version='v2'").get()).toEqual({ count: 0 });
    expect(fixture.db.db.prepare("SELECT delivery_disposition AS disposition FROM conversation_participation_ticks").get()).toEqual({ disposition: "not_applicable" });
    fixture.db.close();
  });
  it("anchors an apply tick to the eligible work rather than a newer unworked event", async () => {
    const fixture = setup({ settings: { conversationParticipationMode: "apply" } });
    fixture.db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
      VALUES (?, ?, NULL, NULL, 'newer-unworked', 'user', 'discord', 'newer', ?, ?, 0, ?, ?)`)
      .run(`discord:${scope.guildId}:${scope.channelId}`, scope.channelId, new Date(now + 1).toISOString(), new Date(now + 1).toISOString(), JSON.stringify({ discordAuthorId: "100000000000000005", discordAuthorBot: false }), new Date(now + 1).toISOString());
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: provider(appraisal(), fixture.calls),
      primary: { decide: async () => ({ kind: "valid" as const, proposal: { schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary, decision: "observe" as const, baselineDecision: "observe" as const, judgmentClass: "definitive" as const, semanticMargin: 1, priorApplied: false, confidence: 1, chunks: [] } }) },
      validator: { validate: async () => ({ kind: "unavailable" as const, diagnostic: "unused" }) },
      primaryModel: "primary-model", validatorModel: "validator-model",
      startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("observe");
    expect(fixture.db.db.prepare("SELECT anchor_work_id FROM conversation_participation_ticks").get()).toEqual({ anchor_work_id: "work-1" });
    expect(fixture.db.db.prepare("SELECT snapshot_high_watermark_id AS highWatermark FROM conversation_participation_ticks").get()).toEqual({ highWatermark: 1 });
    fixture.db.close();
  });
  it("keeps canonical context intact under other-source flooding and fetches a reply ancestor beyond the seed", async () => {
    const fixture = setup({ settings: { conversationParticipationMode: "apply" } });
    const scopeId = `discord:${scope.guildId}:${scope.channelId}`;
    const insert = fixture.db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
      VALUES (?, ?, NULL, NULL, ?, 'user', ?, ?, ?, ?, 0, ?, ?)`);
    const stamp = new Date(now).toISOString();
    insert.run(scopeId, scope.channelId, "ancestor", "discord-participant", "ancestor", stamp, stamp, JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false }), stamp);
    for (let index = 0; index < 97; index += 1) {
      insert.run(scopeId, scope.channelId, `seed-${index}`, "discord-participant", `seed ${index}`, stamp, stamp, JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false }), stamp);
    }
    fixture.store.createWork({ id: "work-2", eventId: "child", eventDigest: "digest:child", scope });
    insert.run(scopeId, scope.channelId, "child", "discord-participant", "child", stamp, stamp, JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false, replyTo: { messageId: "ancestor", authorId: "100000000000000004" } }), stamp);
    for (let index = 0; index < 120; index += 1) {
      insert.run(scopeId, scope.channelId, `flood-${index}`, "other-source", "flood", stamp, stamp, JSON.stringify({ discordAuthorId: "attacker", discordAuthorBot: false }), stamp);
    }
    let turns: readonly { readonly messageId: string }[] = [];
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: provider(appraisal(), fixture.calls),
      primary: { decide: async (request: { readonly turns: readonly { readonly messageId: string }[] }) => {
        turns = request.turns;
        return { kind: "valid" as const, proposal: { schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.participationPrimary, decision: "observe" as const, baselineDecision: "observe" as const, judgmentClass: "definitive" as const, semanticMargin: 1, priorApplied: false, confidence: 1, chunks: [] } };
      } },
      validator: { validate: async () => ({ kind: "unavailable" as const, diagnostic: "unused" }) },
      primaryModel: "primary-model", validatorModel: "validator-model",
      startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("observe");
    expect(turns.map((turn) => turn.messageId)).toContain("ancestor");
    expect(turns.map((turn) => turn.messageId)).not.toContain("flood-119");
    expect(fixture.db.db.prepare("SELECT snapshot_high_watermark_id AS highWatermark FROM conversation_participation_ticks").get()).toEqual({ highWatermark: 100 });
    fixture.db.close();
  });
  it("fails closed for apply when configured primary and validator models match", async () => {
    const fixture = setup({ settings: { conversationParticipationMode: "apply" } });
    let primaryCalls = 0;
    fixture.runtime = runtimeFactory()?.({ serviceDb: fixture.db, store: fixture.store, provider: provider(appraisal(), fixture.calls),
      primary: { decide: async () => { primaryCalls += 1; return { kind: "unavailable" as const, diagnostic: "unexpected" }; } },
      validator: { validate: async () => ({ kind: "unavailable" as const, diagnostic: "unexpected" }) },
      primaryModel: "same-model", validatorModel: "same-model",
      startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("provider_unavailable");
    expect(primaryCalls).toBe(0);
    fixture.db.close();
  });
});
