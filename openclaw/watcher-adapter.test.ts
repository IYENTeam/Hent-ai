import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawWatcherAdapter,
  WATCHER_MAX_SCOPES,
  WATCHER_SCOPE_TTL_MS,
  type WatcherAdapterDeps,
} from "./watcher-adapter.js";

const REPEAT = "ship the release today ship the release today";

interface Harness {
  adapter: ReturnType<typeof createOpenClawWatcherAdapter>;
  deliver: ReturnType<typeof vi.fn>;
  critic: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  moderate: ReturnType<typeof vi.fn>;
  warns: unknown[][];
  infos: unknown[][];
  setClock: (v: number) => void;
}

function harness(config: Record<string, unknown>, opts: Partial<WatcherAdapterDeps> = {}): Harness {
  let clock = 1000;
  const warns: unknown[][] = [];
  const infos: unknown[][] = [];
  const deliver = vi.fn(async () => "d1");
  const critic = vi.fn(async () => ({ fixated: true, confidence: 0.9 }));
  const generate = vi.fn(async () => "Let's pivot to something fresh.");
  const moderate = vi.fn(() => true);
  const adapter = createOpenClawWatcherAdapter({
    config,
    logger: { info: (...a) => infos.push(a), warn: (...a) => warns.push(a) },
    deliver: opts.deliver ?? deliver,
    critic: "critic" in opts ? opts.critic : critic,
    generate: "generate" in opts ? opts.generate : generate,
    moderate: "moderate" in opts ? opts.moderate : moderate,
    now: () => clock,
    isoNow: () => new Date(clock).toISOString(),
  });
  return { adapter, deliver, critic, generate, moderate, warns, infos, setClock: (v) => (clock = v) };
}

/** Fire a fixation signal: first agent turn primes the buffer, the second triggers. */
async function fire(h: Harness, id: string, text = REPEAT) {
  return h.adapter.onAgentTurn({ scopeId: "channel:1", channelId: "1", text, messageId: id });
}

describe("createOpenClawWatcherAdapter — defaults & disabled", () => {
  it("uses safe defaults and is a no-op when not enabled", async () => {
    const infos: unknown[][] = [];
    const adapter = createOpenClawWatcherAdapter({
      logger: { info: (...a) => infos.push(a), warn: () => {} },
      deliver: async () => "x",
    });
    adapter.recordUserTurn("channel:1", "hi"); // default id + default isoNow
    expect(await adapter.onAgentTurn({ scopeId: "channel:1", channelId: "1", text: REPEAT, messageId: "a1" })).toBeNull();
    expect(adapter.scopeCount()).toBe(1);
  });

  it("returns null when enabled but no fixation signal yet", async () => {
    const h = harness({ enabled: true });
    expect(await fire(h, "a1")).toBeNull();
  });
});

describe("shadow mode (default on)", () => {
  it("audits but never delivers in shadow mode", async () => {
    const h = harness({ enabled: true }); // shadowMode defaults true
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.allowed).toBe(false);
    expect(audit?.suppressedReason).toBe("shadow_mode");
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.infos.some((line) => String(line[0]).includes("suppressed=shadow_mode"))).toBe(true);
  });
});

describe("live delivery pipeline", () => {
  it("delivers on a confirmed signal and commits cooldown", async () => {
    const h = harness({ enabled: true, shadowMode: false });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.allowed).toBe(true);
    expect(audit?.deliveryMessageId).toBe("d1");
    expect(audit?.criticConfidence).toBe(0.9);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    // third turn within cooldown window -> suppressed
    const third = await fire(h, "a3");
    expect(third?.suppressedReason).toBe("cooldown");
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("asks the host to replace the offending message in place (mode B)", async () => {
    const h = harness({ enabled: true, shadowMode: false });
    await fire(h, "a1");
    await fire(h, "a2");
    expect(h.deliver).toHaveBeenCalledWith("1", "Let's pivot to something fresh.", {
      replaceMessageId: "a2",
    });
  });

  it("suppresses a duplicate signal id (cooldownMs=0 isolates duplicate)", async () => {
    const h = harness({ enabled: true, shadowMode: false, cooldownMs: 0 });
    await fire(h, "dup"); // primes
    const first = await fire(h, "dup"); // signalId sig-stale-dup -> delivered
    expect(first?.deliveryMessageId).toBe("d1");
    const second = await fire(h, "dup"); // same signalId -> duplicate
    expect(second?.suppressedReason).toBe("duplicate");
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("fail-closes when the per-channel critic budget is exhausted", async () => {
    const h = harness({ enabled: true, shadowMode: false, cooldownMs: 0, budgetPerHour: 1 });
    await fire(h, "a1");
    await fire(h, "a2"); // consumes the single budget unit, delivers
    const audit = await fire(h, "a3"); // budget exhausted
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(h.warns.some((l) => String(l[0]).includes("budget exceeded"))).toBe(true);
  });

  it("resets the budget window after an hour while the scope stays active", async () => {
    const h = harness({ enabled: true, shadowMode: false, cooldownMs: 0, budgetPerHour: 1 });
    await fire(h, "a1");
    await fire(h, "a2"); // delivers; budget windowStart=1000, count=1
    // Keep the scope alive with sub-TTL gaps (TTL is 30min) while crossing the 1h budget window.
    h.setClock(1_500_000);
    await fire(h, "a3"); // ~25min later: alive, budget still exhausted
    h.setClock(3_000_000);
    await fire(h, "a4"); // ~25min later: alive, budget still exhausted
    h.setClock(3_650_000); // >1h since windowStart, <30min since a4
    const audit = await fire(h, "a5"); // budget window reset -> delivers again
    expect(audit?.deliveryMessageId).toBe("d1");
  });

  it("fail-closes when live but LLM deps are missing", async () => {
    const h = harness({ enabled: true, shadowMode: false }, { critic: undefined, generate: undefined, moderate: undefined });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(h.warns.some((l) => String(l[0]).includes("LLM critic/generator/moderator missing"))).toBe(true);
  });

  it("fail-closes when the critic returns null", async () => {
    const h = harness({ enabled: true, shadowMode: false }, { critic: vi.fn(async () => null) });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.warns.some((l) => String(l[0]).includes("critic returned null"))).toBe(true);
  });

  it("fail-closes (no crash) when an LLM dependency throws", async () => {
    const h = harness({ enabled: true, shadowMode: false }, {
      critic: vi.fn(async () => {
        throw new Error("LLM exploded");
      }),
    });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit).not.toBeNull();
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.warns.some((l) => String(l[0]).includes("LLM pipeline raised"))).toBe(true);
  });

  it("does not deliver when the critic says not fixated", async () => {
    const h = harness({ enabled: true, shadowMode: false }, { critic: vi.fn(async () => ({ fixated: false, confidence: 0.95 })) });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.criticConfidence).toBe(0.95);
    expect(audit?.deliveryMessageId).toBeUndefined();
  });

  it("does not deliver when confidence is below threshold", async () => {
    const h = harness({ enabled: true, shadowMode: false, confidenceThreshold: 0.7 }, { critic: vi.fn(async () => ({ fixated: true, confidence: 0.5 })) });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.criticConfidence).toBe(0.5);
    expect(audit?.deliveryMessageId).toBeUndefined();
  });

  it("suppresses when generation is empty", async () => {
    const h = harness({ enabled: true, shadowMode: false }, { generate: vi.fn(async () => null) });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(h.warns.some((l) => String(l[0]).includes("moderation failed"))).toBe(true);
  });

  it("suppresses when moderation rejects the nudge", async () => {
    const h = harness({ enabled: true, shadowMode: false }, { moderate: vi.fn(() => false) });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.deliveryMessageId).toBeUndefined();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("stays retryable when the host drops the delivery (returns null id)", async () => {
    const h = harness({ enabled: true, shadowMode: false, cooldownMs: 600_000 }, { deliver: vi.fn(async () => null) });
    await fire(h, "a1");
    const audit = await fire(h, "a2");
    expect(audit?.allowed).toBe(true);
    expect(audit?.deliveryMessageId).toBeUndefined();
    // not committed -> a later turn is NOT cooldown-suppressed
    const third = await fire(h, "a3");
    expect(third?.suppressedReason).toBeUndefined();
  });
});

describe("scope buffer management", () => {
  it("records explicit user-turn ids and bounds the window", async () => {
    const h = harness({ enabled: true });
    for (let i = 0; i < 10; i += 1) h.adapter.recordUserTurn("channel:1", `msg ${i}`, `u${i}`);
    expect(h.adapter.scopeCount()).toBe(1);
  });

  it("evicts idle scopes past the TTL", async () => {
    const h = harness({ enabled: true });
    h.adapter.recordUserTurn("channel:old", "hello");
    h.setClock(1000 + WATCHER_SCOPE_TTL_MS + 1);
    h.adapter.recordUserTurn("channel:new", "world");
    expect(h.adapter.scopeCount()).toBe(1);
  });

  it("caps the number of live scopes", async () => {
    const h = harness({ enabled: true });
    for (let i = 0; i < WATCHER_MAX_SCOPES + 5; i += 1) {
      h.adapter.recordUserTurn(`channel:${i}`, "x");
    }
    expect(h.adapter.scopeCount()).toBeLessThanOrEqual(WATCHER_MAX_SCOPES);
  });
});
