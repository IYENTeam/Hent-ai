import { describe, expect, it } from "vitest";
import * as service from "./index.js";

type Delivery = { deliver: (input: { readonly planId: string; readonly fence: service.Fence; readonly signal: AbortSignal }) => Promise<string> };
type Factory = (options: Record<string, unknown>) => Delivery;
const scope = { guildId: "100000000000000001", channelId: "100000000000000002" };
let now = 1_000_000;

function factory(): Factory {
  const candidate = Reflect.get(service, "createDiscordAmbientDelivery");
  expect(candidate, "retries nonce receipt without duplicate bubble").toBeTypeOf("function");
  return candidate as Factory;
}

function setup(chunks = ["first bubble", "second bubble"]) {
  const db = new service.ServiceDatabase();
  const store = service.createAdaptiveAmbientStore(db, () => now);
  const fence = store.acquireLease("discord-ambient-worker", "delivery")!;
  store.createWork({ id: "work", eventId: "event", eventDigest: "digest", scope });
  const observedAt = new Date(now).toISOString();
  db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
    VALUES (?, ?, NULL, NULL, 'event', 'user', 'discord-participant', 'origin', ?, ?, 0, '{}', ?)`).run(`discord:${scope.guildId}:${scope.channelId}`, scope.channelId, observedAt, observedAt, observedAt);
  expect(store.claimWork("work", fence)).toBe(true);
  store.recordOutcome({
    fence, eventId: "event", scope, outcome: "planned", workId: "work", state: { drive: 0.6, version: 1 },
    plan: { id: "plan", workId: "work", chunks: chunks.map((content, index) => ({ content, nonce: `nonce-${index}` })) },
  });
  return { db, store, fence };
}

describe("nonce-fenced ambient delivery", () => {
  it("retries nonce receipt without duplicate bubble", async () => {
    const fixture = setup(["single bubble"]);
    const calls: string[] = []; const accepted = new Map<string, string>(); let loseResponse = true;
    const delivery = factory()({ store: fixture.store, clock: () => now, delay: async () => { calls.push("delay"); }, client: {
      sendTyping: async () => { calls.push("typing"); },
      createMessage: async (_channelId: string, _content: string, nonce: string) => {
        calls.push(`send:${nonce}`); expect(fixture.db.db.prepare("SELECT nonce FROM participant_delivery_chunks").get()).toEqual({ nonce });
        const id = accepted.get(nonce) ?? `message-${accepted.size + 1}`; accepted.set(nonce, id);
        if (loseResponse) { loseResponse = false; throw new Error("response lost after acceptance"); }
        return { id };
      },
    } });
    await expect(delivery.deliver({ planId: "plan", fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("retryable");
    await expect(delivery.deliver({ planId: "plan", fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("delivered");
    expect(accepted).toEqual(new Map([["nonce-0", "message-1"]]));
    expect(fixture.db.db.prepare("SELECT nonce,discord_message_id FROM participant_delivery_receipts").all()).toEqual([{ nonce: "nonce-0", discord_message_id: "message-1" }]);
    expect(calls.filter((call) => call.startsWith("send:"))).toEqual(["send:nonce-0", "send:nonce-0"]);
    await expect(delivery.deliver({ planId: "plan", fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("delivered");
    expect(calls.filter((call) => call.startsWith("send:"))).toHaveLength(2); fixture.db.close();
  });

  it("shows typing during length delay before send and resumes the first unreceipted chunk", async () => {
    const fixture = setup(["a".repeat(140), "b".repeat(141)]); const calls: string[] = []; let failSecond = true;
    const delivery = factory()({ store: fixture.store, clock: () => now, delay: async (ms: number) => { calls.push(`delay:${ms}`); }, client: {
      sendTyping: async () => { calls.push("typing"); }, createMessage: async (_channelId: string, content: string, nonce: string) => {
        calls.push(`send:${content.length}`); if (nonce === "nonce-1" && failSecond) { failSecond = false; throw new Error("429"); } return { id: `message-${nonce}` };
      },
    } });
    await expect(delivery.deliver({ planId: "plan", fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("retryable");
    expect(fixture.db.db.prepare("SELECT chunk_index FROM participant_delivery_receipts").all()).toEqual([{ chunk_index: 0 }]);
    await expect(delivery.deliver({ planId: "plan", fence: fixture.fence, signal: new AbortController().signal })).resolves.toBe("delivered");
    expect(calls).toEqual(["typing", "delay:700", "send:140", "typing", "delay:705", "send:141", "typing", "delay:705", "send:141"]);
    expect(fixture.db.db.prepare("SELECT status FROM participant_delivery_plans").get()).toEqual({ status: "delivered" }); fixture.db.close();
  });

  it("aborts the active delay on lease-loss signal after typing and before send or receipt", async () => {
    const fixture = setup(["delayed bubble"]); const controller = new AbortController(); const calls: string[] = [];
    let releaseDelayStarted: (() => void) | undefined;
    const delayStarted = new Promise<void>((resolve) => { releaseDelayStarted = resolve; });
    const delivery = factory()({ store: fixture.store, clock: () => now, delay: async (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true }); releaseDelayStarted?.();
    }), client: { sendTyping: async () => { calls.push("typing"); }, createMessage: async () => { calls.push("send"); return { id: "message" }; } } });
    const pending = delivery.deliver({ planId: "plan", fence: fixture.fence, signal: controller.signal });
    await delayStarted; controller.abort(new Error("lease lost"));
    await expect(pending).resolves.toBe("aborted"); expect(calls).toEqual(["typing"]);
    expect(fixture.db.db.prepare("SELECT COUNT(*) AS count FROM participant_delivery_receipts").get()).toEqual({ count: 0 }); fixture.db.close();
  });

  it("fails closed for unsafe bubble normalization and stale fences while preserving the tick boundary", async () => {
    const normalize = Reflect.get(service, "normalizeDiscordAmbientBubbles") as (chunks: readonly string[]) => readonly string[] | null;
    expect(normalize(["a".repeat(700)])).toHaveLength(5);
    expect(normalize(["a".repeat(701)])).toBeNull();
    expect(normalize(["a".repeat(1801)])).toBeNull();
    const stale = setup(["never sent"]); now += 30_001;
    const noDispatch = factory()({ store: stale.store, clock: () => now, delay: async () => { throw new Error("delay"); }, client: { sendTyping: async () => { throw new Error("typing"); }, createMessage: async () => { throw new Error("send"); } } });
    await expect(noDispatch.deliver({ planId: "plan", fence: stale.fence, signal: new AbortController().signal })).resolves.toBe("aborted"); stale.db.close(); now = 1_000_000;
    const bounded = setup(); let sends = 0;
    const delivery = factory()({ store: bounded.store, clock: () => now, delay: async () => {}, client: {
      sendTyping: async () => {}, createMessage: async () => {
        sends += 1;
        if (sends === 1) bounded.db.db.prepare(`INSERT INTO conversation_raw_events (scope_id,channel_id,thread_id,session_id,message_id,author_role,author_source,text,event_ts,observed_at,bot_self_loop,metadata_json,created_at)
          VALUES (?, ?, NULL, NULL, 'newer-human', 'user', 'discord-participant', 'new', ?, ?, 0, '{}', ?)`).run(`discord:${scope.guildId}:${scope.channelId}`, scope.channelId, new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
        return { id: `message-${sends}` };
      },
    } });
    await expect(delivery.deliver({ planId: "plan", fence: bounded.fence, signal: new AbortController().signal })).resolves.toBe("delivered");
    expect(bounded.db.db.prepare("SELECT status FROM participant_delivery_plans").get()).toEqual({ status: "delivered" });
    expect(bounded.db.db.prepare("SELECT COUNT(*) AS count FROM participant_delivery_receipts").get()).toEqual({ count: 2 }); bounded.db.close();
  });
});
