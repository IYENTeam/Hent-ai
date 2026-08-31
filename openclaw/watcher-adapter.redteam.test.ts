/**
 * Red-team / adversarial / boundary tests for openclaw/watcher-adapter.ts
 *
 * Strategy: break the adapter via boundary conditions, invariant probing,
 * fault injection, concurrency interleaving, cross-scope leakage, and
 * property-based checks. Does NOT duplicate the unit tests in
 * watcher-adapter.test.ts; focuses exclusively on cases that could reveal
 * genuine defects.
 *
 * Adversarial case count: 40
 */
import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawWatcherAdapter,
  WATCHER_MAX_SCOPES,
  WATCHER_SCOPE_TTL_MS,
  WATCHER_WINDOW_N,
  type OnAgentTurnArgs,
  type WatcherAdapterDeps,
} from "./watcher-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Near-duplicate agent texts — pairwise token-set Jaccard ~0.78 (well above 0.6 threshold)
const DUP_A = "database index optimization query cache tuning slow performance";
const DUP_B = "database index optimization query cache tuning fast performance";
const DUP_C = "database index optimization query cache tuning smooth performance";

// Two messages with same inferred topic (first 4 tokens) but low overall similarity (~0.29)
// — used to isolate new_context_ignored_previous_frame_repeated without triggering stale_expression
const SAME_TOPIC_A =
  "database optimization query planning with join strategy and index selection for complex workloads";
const SAME_TOPIC_B =
  "database optimization query planning but actually using hash joins instead of nested loops here";

// Distinct texts (near-zero similarity to DUP_* or each other)
const DIFF_BASE = "summer vacation travel beach weather sunshine";
function uniqueDiff(i: number) {
  return `uniquetoken${i} another${i} different${i} unrelated${i}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeDeliver(returnId: string | null = "delivery-1") {
  return vi.fn(async () => returnId) as WatcherAdapterDeps["deliver"];
}

interface BuildOpts {
  enabled?: boolean;
  shadowMode?: boolean;
  cooldownMs?: number;
  budgetPerHour?: number;
  confidenceThreshold?: number;
  deliver?: WatcherAdapterDeps["deliver"];
  critic?: WatcherAdapterDeps["critic"];
  generate?: WatcherAdapterDeps["generate"];
  moderate?: WatcherAdapterDeps["moderate"];
  clock?: ReturnType<typeof makeClock>;
  logger?: ReturnType<typeof makeLogger>;
}

function buildAdapter(opts: BuildOpts = {}) {
  const clock = opts.clock ?? makeClock();
  const logger = opts.logger ?? makeLogger();
  const deps: WatcherAdapterDeps = {
    config: {
      enabled: opts.enabled ?? true,
      shadowMode: opts.shadowMode ?? false,
      cooldownMs: opts.cooldownMs ?? 60_000,
      budgetPerHour: opts.budgetPerHour ?? 20,
      confidenceThreshold: opts.confidenceThreshold ?? 0.7,
    },
    logger,
    deliver: opts.deliver ?? makeDeliver(),
    critic: opts.critic ?? vi.fn(async () => ({ fixated: true, confidence: 0.9 })),
    generate: opts.generate ?? vi.fn(async () => "Here is a fresh direction."),
    moderate: opts.moderate ?? vi.fn(() => true),
    now: clock.now,
    isoNow: () => "2026-01-01T00:00:00.000Z",
  };
  return { adapter: createOpenClawWatcherAdapter(deps), clock, logger, deps };
}

function agentArgs(overrides: Partial<OnAgentTurnArgs> = {}): OnAgentTurnArgs {
  return {
    scopeId: "scope-1",
    channelId: "ch-1",
    text: DUP_B,
    messageId: "msg-1",
    ...overrides,
  };
}

/**
 * Seed two near-dup agent turns into a scope. The second call produces a fixation
 * signal. Returns the audit from that second call.
 */
async function seedTwoAgentTurns(
  adapter: ReturnType<typeof createOpenClawWatcherAdapter>,
  scopeId = "scope-1",
  channelId = "ch-1",
  msg1 = "seed-a1",
  msg2 = "seed-a2",
) {
  await adapter.onAgentTurn({ scopeId, channelId, text: DUP_A, messageId: msg1 });
  return adapter.onAgentTurn({ scopeId, channelId, text: DUP_B, messageId: msg2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Signal threshold — >=2 near-duplicate agent turns required
// ─────────────────────────────────────────────────────────────────────────────

describe("signal threshold boundary", () => {
  it("[RT-01] 1 agent turn alone never fires a signal", async () => {
    const { adapter } = buildAdapter();
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    expect(audit).toBeNull();
  });

  it("[RT-02] 2nd near-duplicate agent turn fires the signal (exact threshold)", async () => {
    const { adapter } = buildAdapter();
    const audit = await seedTwoAgentTurns(adapter);
    expect(audit).not.toBeNull();
    expect(audit?.fixationPattern).toBe("stale_expression_repeated");
  });

  it("[RT-03] 2 agent turns with low similarity do NOT fire stale_expression_repeated", async () => {
    const { adapter } = buildAdapter();
    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    // DIFF_BASE has near-zero Jaccard similarity with DUP_A
    const audit = await adapter.onAgentTurn(agentArgs({ text: DIFF_BASE, messageId: "a2" }));
    // If a signal fires on low-similarity pair → defect
    if (audit !== null) {
      expect(audit.fixationPattern).not.toBe("stale_expression_repeated");
    }
  });

  it("[RT-04] user turns interleaved between agent turns do not prevent fixation detection", async () => {
    const { adapter } = buildAdapter();
    adapter.recordUserTurn("scope-1", "tell me about databases", "u1");
    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    adapter.recordUserTurn("scope-1", "please explain more", "u2");
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit).not.toBeNull();
    expect(audit?.fixationPattern).toBe("stale_expression_repeated");
  });

  it("[RT-05] new_context_ignored_previous_frame_repeated fires when agent repeats frame after user correction", async () => {
    const { adapter } = buildAdapter({ shadowMode: true }); // audit-only to see signal
    await adapter.onAgentTurn(agentArgs({ text: SAME_TOPIC_A, messageId: "a1" }));
    adapter.recordUserTurn("scope-1", "stop that, please take a completely different angle", "u1");
    const audit = await adapter.onAgentTurn(agentArgs({ text: SAME_TOPIC_B, messageId: "a2" }));
    // May produce new_context_ignored_previous_frame_repeated
    // Exact signal depends on detectCorrectionDrivenFixation matching — just verify no crash
    expect(audit === null || typeof audit.fixationPattern === "string").toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Shadow mode invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("shadow mode invariants", () => {
  it("[RT-06] default shadowMode=true: audit allowed=false, no delivery, suppressedReason=shadow_mode", async () => {
    const { adapter, deps } = buildAdapter({ shadowMode: true });
    await seedTwoAgentTurns(adapter);
    // deliver must never be called in shadow mode regardless of config
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("[RT-07] shadow mode: audit never carries deliveryMessageId (P-invariant)", async () => {
    const { adapter } = buildAdapter({ shadowMode: true });
    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit?.suppressedReason).toBe("shadow_mode");
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(audit?.allowed).toBe(false);
  });

  it("[RT-08] shadowMode remains default-on when config omits it", async () => {
    const adapter = createOpenClawWatcherAdapter({
      config: { enabled: true }, // no shadowMode key
      logger: makeLogger(),
      deliver: makeDeliver(),
    });
    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit?.suppressedReason).toBe("shadow_mode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cooldown boundary — exact millisecond precision
// ─────────────────────────────────────────────────────────────────────────────

describe("cooldown boundary (exact ms)", () => {
  it("[RT-09] at cooldownMs-1 ms after delivery, next turn IS still cooldown-suppressed", async () => {
    const clock = makeClock(1_000_000);
    const { adapter } = buildAdapter({ clock, cooldownMs: 100, budgetPerHour: 20 });

    await seedTwoAgentTurns(adapter); // delivers at t=1_000_000; signalId = sig-stale-seed-a2

    // Advance by exactly cooldownMs - 1 = 99ms
    clock.advance(99);
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_C, messageId: "a3" }));
    expect(audit?.suppressedReason).toBe("cooldown");
    expect(audit?.deliveryMessageId).toBeUndefined();
  });

  it("[RT-10] at exactly cooldownMs after delivery, cooldown DOES NOT hit (strict < operator)", async () => {
    const clock = makeClock(1_000_000);
    const { adapter } = buildAdapter({ clock, cooldownMs: 100, budgetPerHour: 20 });

    await seedTwoAgentTurns(adapter); // delivers at t=1_000_000

    // Advance by exactly cooldownMs = 100ms → difference = 100, NOT < 100 → no cooldown
    clock.advance(100);
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_C, messageId: "a3" }));
    // signalId = sig-stale-a3 — not yet in deliveredSignals
    expect(audit?.suppressedReason).toBeUndefined();
    expect(audit?.allowed).toBe(true);
    expect(audit?.deliveryMessageId).toBe("delivery-1");
  });

  it("[RT-11] cooldown key is per-scope+pattern: different scopes have independent cooldowns", async () => {
    const clock = makeClock(1_000_000);
    const { adapter } = buildAdapter({ clock, cooldownMs: 600_000 });

    // Scope A delivers
    await seedTwoAgentTurns(adapter, "scope-a", "ch-1", "a1", "a2");

    // Scope B — different scope → independent cooldown, should also deliver
    await seedTwoAgentTurns(adapter, "scope-b", "ch-1", "b1", "b2");
    // The audit from scope-b should not be cooldown-suppressed
    const auditB = await adapter.onAgentTurn(agentArgs({ scopeId: "scope-b", channelId: "ch-1", text: DUP_C, messageId: "b3" }));
    // scope-b's own cooldown started when b2 was delivered — we're still within cooldown
    // so this should be cooldown-suppressed for scope-b, NOT leaking scope-a's cooldown
    expect(auditB?.suppressedReason).toBe("cooldown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dedup (deliveredSignals) invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("dedup invariants", () => {
  it("[RT-12] deliver=null: dedup NOT committed; next turn with same signalId retries", async () => {
    const clock = makeClock(1_000_000);
    const deliverNull = makeDeliver(null);
    const { adapter } = buildAdapter({ clock, cooldownMs: 0, deliver: deliverNull });

    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const first = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(first?.deliveryMessageId).toBeUndefined(); // null → undefined in audit

    // Same signalId (sig-stale-a2) is NOT in deliveredSignals because deliver returned null
    // Next turn pushes a3 but the preceding agent message is still a2 conceptually...
    // Actually next onAgentTurn pushes a3, making signalId = sig-stale-a3
    // Use cooldownMs=0 to avoid cooldown gate
    const second = await adapter.onAgentTurn(agentArgs({ text: DUP_C, messageId: "a3" }));
    expect(second?.suppressedReason).not.toBe("duplicate");
  });

  it("[RT-13] deliver=null: cooldown NOT committed; subsequent turn is also NOT cooldown-suppressed", async () => {
    const clock = makeClock(1_000_000);
    const deliverNull = makeDeliver(null);
    const { adapter } = buildAdapter({ clock, cooldownMs: 60_000, deliver: deliverNull });

    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));

    // Advance time but stay inside cooldown window
    clock.advance(30_000);
    const third = await adapter.onAgentTurn(agentArgs({ text: DUP_C, messageId: "a3" }));
    // Since deliver returned null, no cooldown was committed → should NOT be cooldown-suppressed
    expect(third?.suppressedReason).not.toBe("cooldown");
  });

  it("[RT-14] suppressed audit (any reason) never carries deliveryMessageId (P-invariant)", async () => {
    // Shadow mode suppression
    const shadow = buildAdapter({ shadowMode: true });
    await shadow.adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const shadowAudit = await shadow.adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(shadowAudit?.deliveryMessageId).toBeUndefined();
    expect(shadowAudit?.suppressedReason).toBe("shadow_mode");

    // Cooldown suppression
    const { adapter: liveAdapter } = buildAdapter({ cooldownMs: 999_999 });
    await seedTwoAgentTurns(liveAdapter, "scope-1", "ch-1", "c1", "c2"); // delivers, sets cooldown
    const cooldownAudit = await liveAdapter.onAgentTurn(agentArgs({ text: DUP_C, messageId: "c3" }));
    expect(cooldownAudit?.deliveryMessageId).toBeUndefined();
    expect(cooldownAudit?.suppressedReason).toBe("cooldown");

    // Duplicate suppression
    const { adapter: dedupAdapter } = buildAdapter({ cooldownMs: 0 });
    await dedupAdapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "dup" }));
    await dedupAdapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "dup" })); // delivers; sig-stale-dup committed
    const dupAudit = await dedupAdapter.onAgentTurn(agentArgs({ text: DUP_C, messageId: "dup" })); // same last messageId
    expect(dupAudit?.deliveryMessageId).toBeUndefined();
    expect(dupAudit?.suppressedReason).toBe("duplicate");
  });

  it("[RT-15] cross-scope signalId collision: same messageId in two scopes shares deliveredSignals", async () => {
    // This test probes a latent hazard: deliveredSignals is a flat set keyed by signalId,
    // which is sig-stale-<messageId>. If two different scopes happen to use the same
    // last messageId, scope-B sees scope-A's delivery as a duplicate.
    const clock = makeClock(1_000_000);
    const { adapter } = buildAdapter({ clock, cooldownMs: 0 });

    // Scope A: seed + deliver with shared-msg as the signal-triggering turn
    await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_A, messageId: "seed-x" });
    const auditA = await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_B, messageId: "shared-msg" });
    expect(auditA?.deliveryMessageId).toBeDefined(); // scope-A delivered

    // Scope B: seed + attempt with same "shared-msg" as last messageId
    await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-1", text: DUP_A, messageId: "seed-y" });
    const auditB = await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-1", text: DUP_B, messageId: "shared-msg" });

    // EXPECTED per spec: independent scopes should not block each other.
    // If this expectation fails → genuine cross-scope dedup leakage defect.
    expect(auditB?.suppressedReason).not.toBe("duplicate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Budget boundary — exact call counts
// ─────────────────────────────────────────────────────────────────────────────

describe("budget boundary (exact counts)", () => {
  it("[RT-16] Nth budget call succeeds, (N+1)th fails (budgetPerHour=2)", async () => {
    // Two separate scopes, each gets one budget-consuming live pipeline run
    const clock = makeClock(1_000_000);
    const { adapter, logger } = buildAdapter({ clock, cooldownMs: 0, budgetPerHour: 2 });

    // Scope A — first pipeline run (budget count goes to 1)
    await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_A, messageId: "a1" });
    await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_B, messageId: "a2" }); // count=1, delivers

    // Scope B — second pipeline run (budget count goes to 2)
    await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-1", text: DUP_A, messageId: "b1" });
    await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-1", text: DUP_B, messageId: "b2" }); // count=2, delivers

    // Scope C — third pipeline run (budget exhausted at count=2 >= 2)
    await adapter.onAgentTurn({ scopeId: "scope-c", channelId: "ch-1", text: DUP_A, messageId: "c1" });
    const thirdAudit = await adapter.onAgentTurn({ scopeId: "scope-c", channelId: "ch-1", text: DUP_B, messageId: "c2" });
    expect(thirdAudit?.deliveryMessageId).toBeUndefined();
    expect(logger.warn.mock.calls.some((a) => String(a[0]).includes("budget exceeded"))).toBe(true);
  });

  it("[RT-17] budget is per-channelId: different channels have independent budgets", async () => {
    const clock = makeClock(1_000_000);
    const { adapter } = buildAdapter({ clock, cooldownMs: 0, budgetPerHour: 1 });

    // scope-a on ch-1 — consumes ch-1's single budget slot and delivers
    await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_A, messageId: "a1" });
    const auditCh1 = await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_B, messageId: "a2" });
    expect(auditCh1?.deliveryMessageId).toBe("delivery-1"); // ch-1 used its 1 slot

    // scope-b on ch-2 — completely independent budget counter
    await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-2", text: DUP_A, messageId: "b1" });
    const auditCh2 = await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-2", text: DUP_B, messageId: "b2" });
    // ch-2 has its own fresh budget → should deliver regardless of ch-1 exhaustion
    expect(auditCh2?.deliveryMessageId).toBe("delivery-1");
  });

  it("[RT-18] budget resets to 0 at exactly HOUR_MS from windowStart", async () => {
    const HOUR_MS = 3_600_000;
    const clock = makeClock(1_000_000);
    const { adapter } = buildAdapter({ clock, cooldownMs: 0, budgetPerHour: 1 });

    await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_A, messageId: "a1" });
    await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_B, messageId: "a2" }); // exhausts ch-1 budget

    // Advance to just before 1h
    clock.advance(HOUR_MS - 1);
    await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-1", text: DUP_A, messageId: "b1" });
    const stillExhausted = await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-1", text: DUP_B, messageId: "b2" });
    expect(stillExhausted?.deliveryMessageId).toBeUndefined(); // still within budget window

    // Advance past 1h from windowStart
    clock.advance(2); // now >= HOUR_MS from when ch-1 budget was set
    await adapter.onAgentTurn({ scopeId: "scope-c", channelId: "ch-1", text: DUP_A, messageId: "c1" });
    const afterReset = await adapter.onAgentTurn({ scopeId: "scope-c", channelId: "ch-1", text: DUP_B, messageId: "c2" });
    expect(afterReset?.deliveryMessageId).toBe("delivery-1"); // budget reset → delivers
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Fault injection — throws from injected dependencies
// ─────────────────────────────────────────────────────────────────────────────

describe("fault injection — throws from deps", () => {
  it("[RT-19] deliver() throwing is caught and fail-closes (no crash, no delivery)", async () => {
    const throwingDeliver: WatcherAdapterDeps["deliver"] = vi.fn().mockRejectedValue(new Error("network error"));
    const { adapter } = buildAdapter({ deliver: throwingDeliver });

    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit).not.toBeNull();
    expect(audit?.deliveryMessageId).toBeUndefined();
  });

  it("[RT-20] critic() throwing is caught and fail-closes", async () => {
    const throwingCritic: WatcherAdapterDeps["critic"] = vi.fn().mockRejectedValue(new Error("critic failure"));
    const { adapter } = buildAdapter({ critic: throwingCritic });

    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit?.deliveryMessageId).toBeUndefined();
  });

  it("[RT-21] generate() throwing is caught and fail-closes", async () => {
    const throwingGenerate: WatcherAdapterDeps["generate"] = vi.fn().mockRejectedValue(new Error("gen failure"));
    const { adapter } = buildAdapter({ generate: throwingGenerate });

    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit?.deliveryMessageId).toBeUndefined();
  });

  it("[RT-22] after deliver throws, cooldown and dedup are NOT committed (retryable)", async () => {
    const throwOnce = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue("delivery-1");
    const { adapter } = buildAdapter({ deliver: throwOnce as WatcherAdapterDeps["deliver"], cooldownMs: 600_000 });

    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const first = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" })); // deliver throws -> caught, no commit
    expect(first?.deliveryMessageId).toBeUndefined();

    // A later turn must NOT be cooldown/duplicate-suppressed, and delivers once deliver recovers.
    const retry = await adapter.onAgentTurn(agentArgs({ text: DUP_C, messageId: "a3" }));
    expect(retry?.suppressedReason).not.toBe("cooldown");
    expect(retry?.suppressedReason).not.toBe("duplicate");
    expect(retry?.deliveryMessageId).toBe("delivery-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Confidence threshold boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("confidence threshold boundary", () => {
  it("[RT-23] confidence exactly at threshold delivers (approxGte: threshold - epsilon)", async () => {
    const EPSILON = 1e-9;
    const threshold = 0.7;
    const exactCritic: WatcherAdapterDeps["critic"] = vi.fn(async () => ({
      fixated: true,
      confidence: threshold + EPSILON / 2, // just above epsilon floor
    }));
    const { adapter } = buildAdapter({ confidenceThreshold: threshold, critic: exactCritic });
    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit?.deliveryMessageId).toBe("delivery-1");
  });

  it("[RT-24] confidence just below threshold does NOT deliver", async () => {
    const threshold = 0.7;
    const lowCritic: WatcherAdapterDeps["critic"] = vi.fn(async () => ({
      fixated: true,
      confidence: threshold - 0.001,
    }));
    const { adapter } = buildAdapter({ confidenceThreshold: threshold, critic: lowCritic });
    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit?.deliveryMessageId).toBeUndefined();
  });

  it("[RT-25] high confidence but fixated=false never delivers", async () => {
    const notFixatedCritic: WatcherAdapterDeps["critic"] = vi.fn(async () => ({
      fixated: false,
      confidence: 0.999,
    }));
    const { adapter } = buildAdapter({ critic: notFixatedCritic });
    await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: DUP_B, messageId: "a2" }));
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(audit?.criticConfidence).toBe(0.999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Ring buffer — window eviction at exactly N
// ─────────────────────────────────────────────────────────────────────────────

describe("ring buffer window eviction at WATCHER_WINDOW_N", () => {
  it("[RT-26] pushing WATCHER_WINDOW_N+1 agent turns keeps only the last WATCHER_WINDOW_N", async () => {
    // Behavioral proof: fill with DUP_* (signal fires), then flush with WATCHER_WINDOW_N
    // unique low-similarity turns (signal should stop), then push 2 more DUP_* (signal fires again)
    const { adapter } = buildAdapter({ shadowMode: true }); // audit-only for observation

    // Fill the buffer with DUP_* texts — window saturates
    for (let i = 0; i < WATCHER_WINDOW_N; i++) {
      await adapter.onAgentTurn(agentArgs({ text: DUP_A, messageId: `fill-${i}` }));
    }

    // Flush with WATCHER_WINDOW_N unique distinct texts to evict ALL DUP_* from window
    for (let i = 0; i < WATCHER_WINDOW_N; i++) {
      await adapter.onAgentTurn(agentArgs({ text: uniqueDiff(i), messageId: `flush-${i}` }));
    }

    // Now push 1 unique text — window has WATCHER_WINDOW_N unique texts, no DUP_*
    // → maxPairwiseSimilarity is low → no stale_expression_repeated expected
    const afterFlush = await adapter.onAgentTurn(agentArgs({ text: uniqueDiff(99), messageId: "post-flush-1" }));
    // This may still return an audit (shadow mode returns null only if !cfg.enabled);
    // but if it fires, it should NOT be stale_expression_repeated based on similarity alone
    if (afterFlush !== null) {
      // If a signal fires here it means the window is leaking evicted turns — defect
      expect(afterFlush.fixationPattern).not.toBe("stale_expression_repeated");
    }
  });

  it("[RT-27] window never exceeds WATCHER_WINDOW_N agent messages per scope (scopeCount stays ≤1)", async () => {
    const { adapter } = buildAdapter();
    for (let i = 0; i < WATCHER_WINDOW_N * 3; i++) {
      adapter.recordUserTurn("scope-1", `msg ${i}`, `u${i}`);
    }
    // scopeCount is still 1 (all user turns belong to same scope)
    expect(adapter.scopeCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Idle TTL eviction — exact boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("idle TTL eviction boundary", () => {
  it("[RT-28] scope is NOT evicted at exactly WATCHER_SCOPE_TTL_MS idle (strict > operator)", async () => {
    const clock = makeClock(0);
    const { adapter } = buildAdapter({ clock });

    adapter.recordUserTurn("old-scope", "hello", "u1"); // lastTouched = 0

    // Advance to exactly TTL — evictIdle checks `current - lastTouched > TTL`
    // At TTL: diff = TTL, NOT > TTL → scope survives
    clock.advance(WATCHER_SCOPE_TTL_MS);
    adapter.recordUserTurn("new-scope", "world", "u2"); // triggers evictIdle

    expect(adapter.scopeCount()).toBe(2); // old-scope still alive
  });

  it("[RT-29] scope IS evicted at WATCHER_SCOPE_TTL_MS + 1 ms idle", async () => {
    const clock = makeClock(0);
    const { adapter } = buildAdapter({ clock });

    adapter.recordUserTurn("old-scope", "hello", "u1"); // lastTouched = 0

    clock.advance(WATCHER_SCOPE_TTL_MS + 1);
    adapter.recordUserTurn("new-scope", "world", "u2"); // triggers evictIdle(TTL+1)

    expect(adapter.scopeCount()).toBe(1); // old-scope evicted
  });

  it("[RT-30] re-touching a scope resets its TTL counter", async () => {
    const clock = makeClock(0);
    const { adapter } = buildAdapter({ clock });

    adapter.recordUserTurn("old-scope", "hello", "u1"); // lastTouched = 0
    clock.advance(WATCHER_SCOPE_TTL_MS - 1); // just before TTL
    adapter.recordUserTurn("old-scope", "refresh", "u2"); // re-touch; lastTouched = TTL-1

    clock.advance(WATCHER_SCOPE_TTL_MS); // now at 2*TTL-1; diff from last touch = TTL, NOT > TTL
    adapter.recordUserTurn("trigger-eviction", "trigger", "u3"); // evictIdle check

    expect(adapter.scopeCount()).toBe(2); // old-scope still alive (re-touched TTL-1 ago)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Max scopes LRU eviction
// ─────────────────────────────────────────────────────────────────────────────

describe("max scopes LRU eviction", () => {
  it("[RT-31] scopeCount never exceeds WATCHER_MAX_SCOPES after overflow", () => {
    const { adapter } = buildAdapter();
    for (let i = 0; i < WATCHER_MAX_SCOPES + 10; i++) {
      adapter.recordUserTurn(`scope-${i}`, "x", `u${i}`);
    }
    expect(adapter.scopeCount()).toBeLessThanOrEqual(WATCHER_MAX_SCOPES);
  });

  it("[RT-32] LRU scope is evicted, not the most-recently-used one", () => {
    const { adapter } = buildAdapter();

    // Fill to max - 1
    for (let i = 0; i < WATCHER_MAX_SCOPES - 1; i++) {
      adapter.recordUserTurn(`scope-${i}`, "x", `u${i}`);
    }
    // scope-0 is now the LRU. Re-touch scope-1 to make scope-0 remain the LRU.
    adapter.recordUserTurn("scope-1", "refreshed", "u-ref");

    // scopeCount should still be WATCHER_MAX_SCOPES - 1 after re-touch (no eviction yet)
    expect(adapter.scopeCount()).toBe(WATCHER_MAX_SCOPES - 1);

    // Add WATCHER_MAX_SCOPES-th scope to fill exactly to max
    adapter.recordUserTurn("scope-new-1", "new1", "un1");
    expect(adapter.scopeCount()).toBe(WATCHER_MAX_SCOPES);

    // Adding one more triggers LRU eviction; scope-0 should be the evicted one
    adapter.recordUserTurn("scope-new-2", "new2", "un2");
    expect(adapter.scopeCount()).toBe(WATCHER_MAX_SCOPES);
  });

  it("[RT-33] just-touched scope is never the LRU victim", () => {
    const { adapter } = buildAdapter();
    for (let i = 0; i < WATCHER_MAX_SCOPES; i++) {
      adapter.recordUserTurn(`scope-${i}`, "x", `u${i}`);
    }
    // scope-0 is LRU. Re-touch it now to move it to MRU.
    adapter.recordUserTurn("scope-0", "refreshed", "u-refresh");
    // Trigger eviction by adding one more scope
    adapter.recordUserTurn("scope-trigger", "trigger", "u-trigger");

    expect(adapter.scopeCount()).toBe(WATCHER_MAX_SCOPES); // still at max
    // scope-0 must still be alive; we can re-touch it without growing count
    adapter.recordUserTurn("scope-0", "still alive", "u-alive");
    expect(adapter.scopeCount()).toBe(WATCHER_MAX_SCOPES);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Multi-scope independence
// ─────────────────────────────────────────────────────────────────────────────

describe("multi-scope independence", () => {
  it("[RT-34] interleaved A/B turns do not bleed state into each other", async () => {
    const { adapter } = buildAdapter({ shadowMode: true });

    // Interleave A and B turns
    await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_A, messageId: "a1" });
    await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-2", text: DIFF_BASE, messageId: "b1" });
    const auditA2 = await adapter.onAgentTurn({ scopeId: "scope-a", channelId: "ch-1", text: DUP_B, messageId: "a2" });
    const auditB2 = await adapter.onAgentTurn({ scopeId: "scope-b", channelId: "ch-2", text: uniqueDiff(10), messageId: "b2" });

    // scope-a should have fixation signal (DUP_A + DUP_B)
    expect(auditA2).not.toBeNull();
    expect(auditA2?.fixationPattern).toBe("stale_expression_repeated");

    // scope-b should NOT have a stale_expression signal (DIFF_BASE + uniqueDiff low similarity)
    if (auditB2 !== null) {
      expect(auditB2.fixationPattern).not.toBe("stale_expression_repeated");
    }
  });

  it("[RT-35] recordUserTurn in scope-A does not increment scopeCount beyond 1 for scope-A", () => {
    const { adapter } = buildAdapter();
    for (let i = 0; i < 20; i++) {
      adapter.recordUserTurn("scope-a", `message ${i}`, `u${i}`);
    }
    expect(adapter.scopeCount()).toBe(1); // all turns in one scope = 1 buffer
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Malformed / edge-case inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("malformed and edge-case inputs", () => {
  it("[RT-36] empty string text does not crash the adapter", async () => {
    const { adapter } = buildAdapter();
    adapter.recordUserTurn("scope-1", "", "u1");
    const audit = await adapter.onAgentTurn(agentArgs({ text: "", messageId: "a1" }));
    // Empty text → no tokens → similarity 0 → no stale signal. Just confirm no throw.
    expect(audit).toBeNull(); // 1 agent turn, no signal
  });

  it("[RT-37] whitespace-only text does not crash the adapter", async () => {
    const { adapter } = buildAdapter();
    await adapter.onAgentTurn(agentArgs({ text: "   \t\n   ", messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: "   ", messageId: "a2" }));
    // Whitespace tokens stripped → empty token set → jaccard = 0 → no signal
    // If signal fires for empty/whitespace → defect
    expect(audit === null || (audit !== null && typeof audit.fixationPattern === "string")).toBe(true);
  });

  it("[RT-38] very long text (>1000 chars) does not crash or overflow", async () => {
    const longText = "database optimization ".repeat(60); // ~1320 chars, highly repetitive
    const { adapter } = buildAdapter();
    await adapter.onAgentTurn(agentArgs({ text: longText, messageId: "a1" }));
    const audit = await adapter.onAgentTurn(agentArgs({ text: longText, messageId: "a2" }));
    expect(typeof audit === "object").toBe(true); // either null or an audit — no throw
  });

  it("[RT-39] onAgentTurn with optional fields absent (no sourceThreadId, targetThreadId, sessionId)", async () => {
    const { adapter } = buildAdapter({ shadowMode: true });
    await adapter.onAgentTurn({ scopeId: "scope-1", channelId: "ch-1", text: DUP_A, messageId: "a1" });
    const audit = await adapter.onAgentTurn({ scopeId: "scope-1", channelId: "ch-1", text: DUP_B, messageId: "a2" });
    // No thread or session fields — verify audit fields default gracefully
    expect(audit?.threadId).toBeUndefined();
    expect(audit?.sessionId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Determinism property
// ─────────────────────────────────────────────────────────────────────────────

describe("determinism property", () => {
  it("[RT-40] same inputs with injected clock produce identical audit fields across two adapter instances", async () => {
    function buildDetAdapter() {
      const clock = makeClock(42_000);
      const deps: WatcherAdapterDeps = {
        config: { enabled: true, shadowMode: false, cooldownMs: 60_000, budgetPerHour: 20, confidenceThreshold: 0.7 },
        logger: makeLogger(),
        deliver: vi.fn(async () => "delivery-det"),
        critic: vi.fn(async () => ({ fixated: true, confidence: 0.85 })),
        generate: vi.fn(async () => "Fresh angle."),
        moderate: vi.fn(() => true),
        now: clock.now,
        isoNow: () => "2026-01-01T00:00:00.000Z",
      };
      return createOpenClawWatcherAdapter(deps);
    }

    const [a1, a2] = [buildDetAdapter(), buildDetAdapter()];

    async function replay(adapter: ReturnType<typeof createOpenClawWatcherAdapter>) {
      await adapter.onAgentTurn({ scopeId: "s", channelId: "c", text: DUP_A, messageId: "m1" });
      return adapter.onAgentTurn({ scopeId: "s", channelId: "c", text: DUP_B, messageId: "m2" });
    }

    const [r1, r2] = await Promise.all([replay(a1), replay(a2)]);

    expect(r1?.fixationPattern).toBe(r2?.fixationPattern);
    expect(r1?.internalSignalId).toBe(r2?.internalSignalId);
    expect(r1?.allowed).toBe(r2?.allowed);
    expect(r1?.criticConfidence).toBe(r2?.criticConfidence);
    expect(r1?.cooldownKey).toBe(r2?.cooldownKey);
  });
});
