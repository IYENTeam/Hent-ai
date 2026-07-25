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

function roster(): DiscordMembershipSnapshot {
  return { scope, memberIds: ["100000000000000004", "100000000000000005"], complete: true, observedAtMs: now };
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

function setup(options: { readonly enabled?: boolean; readonly allowlisted?: boolean; readonly budgetPerHour?: number; readonly result?: unknown } = {}) {
  const db = new service.ServiceDatabase();
  db.setChannelMapping(scope.channelId, { enabled: options.enabled ?? true });
  const store = service.createAdaptiveAmbientStore(db, () => now);
  const fence = store.acquireLease("discord-ambient-worker", "runtime")!;
  store.createWork({ id: "work-1", eventId: "event-1", eventDigest: "digest-1", scope });
  db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
    VALUES (?, ?, NULL, NULL, ?, 'user', 'discord-participant', ?, ?, ?, 0, ?, ?)`)
    .run(`discord:${scope.guildId}:${scope.channelId}`, scope.channelId, "event-1", "please be quiet", new Date(now).toISOString(), new Date(now).toISOString(), JSON.stringify({ discordAuthorId: "100000000000000004", discordAuthorBot: false, mentions: [botUserId] }), new Date(now).toISOString());
  const calls: string[] = [];
  const runtime = runtimeFactory()?.({ serviceDb: db, store, provider: provider(options.result ?? appraisal(), calls), startup: { enabled: options.allowlisted !== false, allowlist: options.allowlisted === false ? [] : [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: options.budgetPerHour ?? 2, clock: () => now, loadRoster: async () => roster() });
  return { db, store, fence, calls, runtime };
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

  it("updates only drive, version, audit, and work for a valid observe", async () => {
    const fixture = setup({ result: appraisal({ decision: "observe", desiredDrive: 0.8, chunks: [] }) });
    await expect(fixture.runtime!.run({ fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("observe");
    expect(fixture.store.state(scope)).toEqual({ drive: 0.575, version: 1 });
    expect(fixture.store.counts()).toEqual({ audits: 1, states: 1, budgets: 0, relationships: 1, plans: 0 });
    expect(fixture.db.db.prepare("SELECT status FROM participant_event_work WHERE id='work-1'").get()).toEqual({ status: "observe" });
    fixture.db.close();
  });

  it("keeps invalid provider output audit-only and turns provider exceptions into typed invalid outcomes", async () => {
    const invalid = setup({ result: { kind: "invalid", diagnostic: "malformed provider result" } });
    await expect(invalid.runtime!.run({ fence: invalid.fence, signal: new AbortController().signal })).resolves.toBe("invalid");
    expect(invalid.store.counts()).toEqual({ audits: 1, states: 0, budgets: 0, relationships: 0, plans: 0 }); invalid.db.close();
    const lowConfidence = setup({ result: appraisal({ confidence: 0.69 }) });
    await expect(lowConfidence.runtime!.run({ fence: lowConfidence.fence, signal: new AbortController().signal })).resolves.toBe("invalid");
    expect(lowConfidence.store.counts()).toEqual({ audits: 1, states: 0, budgets: 0, relationships: 0, plans: 0 }); lowConfidence.db.close();
    const thrown = setup();
    thrown.runtime = runtimeFactory()?.({ serviceDb: thrown.db, store: thrown.store, provider: { appraise: async () => { thrown.calls.push("provider"); throw new Error("provider failure"); } }, startup: { enabled: true, allowlist: [scope], diagnostics: [] }, scope, botUserId, budgetPerHour: 2, clock: () => now, loadRoster: async () => roster() });
    await expect(thrown.runtime!.run({ fence: thrown.fence, signal: new AbortController().signal })).resolves.toBe("invalid");
    expect(thrown.store.counts()).toEqual({ audits: 1, states: 0, budgets: 0, relationships: 0, plans: 0 });
    expect(thrown.db.db.prepare("SELECT outcome,diagnostic FROM adaptive_ambient_audits").get()).toEqual({ outcome: "invalid", diagnostic: "provider appraisal failed" }); thrown.db.close();
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
});
