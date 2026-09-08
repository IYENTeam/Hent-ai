import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { ServiceDatabase } from "../service/src/db.js";
import { ConversationRuntime } from "../service/src/conversation-runtime.js";
import { ConversationStore } from "../service/src/conversation-store.js";
import { DEFAULT_CONVERSATION_CONFIG } from "../service/src/conversation-config.js";
import { handleWatcherRoute } from "../service/src/watcher-routes.js";

type Handler = (event: unknown, context?: unknown) => Promise<unknown>;
afterEach(() => vi.unstubAllGlobals());

function setup(sendText: (context: { text: string }) => Promise<{ messageId: string }>) {
  const db = new ServiceDatabase();
  const runtime = new ConversationRuntime(db, { ...DEFAULT_CONVERSATION_CONFIG, enabled: true, minDelayMs: 0, maxDelayMs: 0, maxChunkChars: 50 });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, options: RequestInit) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/mapping")) return Response.json({ mapping: { enabled: true } });
    const result = await handleWatcherRoute({ runtime, method: options.method, pathname, body: JSON.parse(String(options.body)) });
    if (!result) throw new Error(`Unexpected route: ${pathname}`);
    return Response.json(result.body, { status: result.status });
  }));
  const handlers = new Map<string, Handler>();
  plugin.register({
    pluginConfig: { hentAiService: { url: "https://hent.test", token: "test", timeoutMs: 250, watcher: true } },
    config: {}, runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText }) } } },
    supportsHook: () => true,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  });
  const context = { channelId: "loopback", conversationId: "channel:123", accountId: "test" };
  const event = (id: string) => ({ to: "channel:123", content: "Repeat the same stale deployment plan with rollback risk", success: true, messageId: id, sessionKey: "s1" });
  return { db, runtime, handlers, context, event };
}

describe("thin adapter with the real conversation service", () => {
  it("retains user records across actual intake hooks", async () => {
    const sendText = vi.fn(async () => ({ messageId: "should-not-send" }));
    const fixture = setup(sendText);
    try {
      for (const id of ["human-1", "human-2"]) await fixture.handlers.get("message_received")!(fixture.event(id), fixture.context);
      const events = new ConversationStore(fixture.db).listRawEvents("channel:123:session:s1");
      expect(events.map((event) => event.authorRole)).toEqual(["user", "user"]);
      expect(sendText).not.toHaveBeenCalled();
    } finally { fixture.db.close(); }
  });

  it("sends each chunk once under concurrent hooks and commits persisted receipts", async () => {
    let entered!: () => void; let resume!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const sent: string[] = [];
    const fixture = setup(async ({ text }) => {
      sent.push(text);
      if (sent.length === 1) { entered(); await blocked; }
      return { messageId: `sent-${sent.length}` };
    });
    try {
      const handler = fixture.handlers.get("message_sent")!;
      await handler(fixture.event("a1"), fixture.context);
      const first = handler(fixture.event("a2"), fixture.context);
      await started;
      await handler(fixture.event("a2"), fixture.context);
      expect(sent).toHaveLength(1);
      resume(); await first;
      const count = sent.length;
      expect(count).toBeGreaterThan(1);
      await handler(fixture.event("a2"), fixture.context);
      expect(sent).toHaveLength(count);
      const row = fixture.db.db.prepare("SELECT status, delivery_message_ids_json FROM conversation_delivery_ledger").get() as { status: string; delivery_message_ids_json: string };
      expect(row.status).toBe("committed");
      expect(Object.keys(JSON.parse(row.delivery_message_ids_json))).toHaveLength(count);
    } finally { resume(); fixture.db.close(); }
  });

  it("skips persisted receipts on recovery and retries a failed commit without resending", async () => {
    let sequence = 1;
    const sendText = vi.fn(async (_context: { text: string }) => ({ messageId: `sent-${++sequence}` }));
    const fixture = setup(sendText);
    try {
      const request = { scopeId: "channel:123:session:s1", channelId: "123", text: fixture.event("a1").content };
      await fixture.runtime.evaluate({ ...request, messageId: "a1" });
      const plan = (await fixture.runtime.evaluate({ ...request, messageId: "a2" })).deliveryPlan!;
      const first = plan.chunks[0]!;
      const progress = { planId: plan.planId, claimId: plan.dispatch!.claimId, chunkId: first.chunkId };
      expect(fixture.runtime.deliveryProgress({ ...progress, action: "begin" })).toBe(true);
      expect(fixture.runtime.deliveryProgress({ ...progress, action: "receipt", messageId: "sent-1" })).toBe(true);
      expect(fixture.runtime.deliveryProgress({ ...progress, action: "release" })).toBe(true);
      vi.spyOn(fixture.runtime, "commitDeliveryPlan").mockImplementationOnce(() => { throw new Error("temporary commit outage"); });
      const handler = fixture.handlers.get("message_sent")!;
      await handler(fixture.event("a2"), fixture.context);
      expect(sendText.mock.calls.map(([context]) => context.text)).toEqual(plan.chunks.slice(1).map((chunk) => chunk.text));
      const count = sendText.mock.calls.length;
      await handler(fixture.event("a2"), fixture.context);
      expect(sendText).toHaveBeenCalledTimes(count);
      expect(fixture.db.db.prepare("SELECT status FROM conversation_delivery_ledger").get()).toEqual({ status: "committed" });
    } finally { fixture.db.close(); }
  });
});
