import { describe, expect, it, vi } from "vitest";
import { createOpenClawWatcherAdapter } from "./watcher-adapter.js";

const REPEAT = "deploy the staging server now deploy the staging server now";

function build(config: Record<string, unknown>) {
  let clock = 1000;
  const infos: unknown[][] = [];
  const deliver = vi.fn(async () => "d1");
  const adapter = createOpenClawWatcherAdapter({
    config,
    logger: { info: (...a) => infos.push(a), warn: () => {} },
    deliver,
    critic: vi.fn(async () => ({ fixated: true, confidence: 0.95 })),
    generate: vi.fn(async () => "Try a fresh angle."),
    moderate: vi.fn(() => true),
    now: () => clock,
    isoNow: () => new Date(clock).toISOString(),
  });
  const fire = (id: string) =>
    adapter.onAgentTurn({ scopeId: "channel:1", channelId: "1", text: REPEAT, messageId: id });
  return { adapter, deliver, infos, fire, setClock: (v: number) => (clock = v) };
}

describe("shadow mode kill-switch", () => {
  it("emits exactly one audit line and zero sends per evaluated fixation turn", async () => {
    const t = build({ enabled: true }); // shadow defaults ON
    expect(await t.fire("a1")).toBeNull(); // priming turn: no signal, no audit
    const audit = await t.fire("a2");
    expect(audit?.allowed).toBe(false);
    expect(audit?.suppressedReason).toBe("shadow_mode");
    expect(audit?.deliveryMessageId).toBeUndefined();
    // exactly one audit log line for the one evaluated (signal-bearing) turn
    expect(t.infos.filter((l) => String(l[0]).includes("watcher: scope=")).length).toBe(1);
    expect(t.deliver).not.toHaveBeenCalled();
  });
});

describe("each gate reason individually suppresses delivery", () => {
  it("shadow_mode suppresses", async () => {
    const t = build({ enabled: true, shadowMode: true });
    await t.fire("a1");
    expect((await t.fire("a2"))?.suppressedReason).toBe("shadow_mode");
    expect(t.deliver).not.toHaveBeenCalled();
  });

  it("cooldown suppresses after a successful live delivery", async () => {
    const t = build({ enabled: true, shadowMode: false, cooldownMs: 600_000 });
    await t.fire("a1");
    expect((await t.fire("a2"))?.deliveryMessageId).toBe("d1"); // delivers, commits cooldown
    const suppressed = await t.fire("a3"); // within cooldown window
    expect(suppressed?.allowed).toBe(false);
    expect(suppressed?.suppressedReason).toBe("cooldown");
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it("duplicate suppresses a repeat of the same signal id", async () => {
    const t = build({ enabled: true, shadowMode: false, cooldownMs: 0 });
    await t.fire("dup");
    expect((await t.fire("dup"))?.deliveryMessageId).toBe("d1");
    const dup = await t.fire("dup");
    expect(dup?.allowed).toBe(false);
    expect(dup?.suppressedReason).toBe("duplicate");
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });

  it("live path with no suppressor delivers (control)", async () => {
    const t = build({ enabled: true, shadowMode: false });
    await t.fire("a1");
    const audit = await t.fire("a2");
    expect(audit?.allowed).toBe(true);
    expect(audit?.deliveryMessageId).toBe("d1");
  });
});
