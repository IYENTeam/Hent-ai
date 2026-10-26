import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSessionRequest, type InboxEvent } from "../src/bridge/contract.ts";
import { startBridge, type BridgeHandle } from "../src/bridge/index.ts";
import { writePrivateFile } from "../src/bridge/journal.ts";
import { startFakeDiscord, waitForEvent } from "./fake-discord.ts";

const ORIGINAL = "1498703634098294976";
const NITRO = "1564082810183221349";
const legacy = { agent: "codex", sessionId: "original", pane: "w1:p1", cwd: "/tmp" } as const;
const nitro = { ...legacy, sessionId: "nitro", pane: "w2:p1", channelId: NITRO, model: "gpt-6.1-sol", effort: "medium" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected object");
  return Object.fromEntries(Object.entries(value));
}

type Entry = { readonly id: string; readonly clientUserMessageId: string; readonly input: unknown };
type Added = { readonly threadId: string; readonly wakeId: string };

async function setup() {
  const home = mkdtempSync("/tmp/hent-routing-");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = join(home, "codex");
  mkdirSync(join(codexHome, "app-server-control"), { recursive: true });
  const events = new EventEmitter();
  const queues = new Map<string, Entry[]>();
  const settings = new Map<string, Record<string, unknown>>([["original", { model: "gpt-6.1-sol", effort: "low" }]]);
  const updates: Record<string, unknown>[] = [];
  const rejected = new Set<string>();
  const unavailable = new Set<string>();
  const states = new Map<string, string>();
  const requests: { method: string; threadId: string }[] = [];
  const rpc = Bun.serve({
    unix: join(codexHome, "app-server-control/app-server-control.sock"),
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        const message = object(JSON.parse(String(data)));
        if (message.method === "initialized") return;
        if (message.method === "initialize") { ws.send(JSON.stringify({ id: message.id, result: {} })); return; }
        const params = object(message.params);
        const threadId = String(params.threadId);
        const method = String(message.method);
        requests.push({ method, threadId });
        if (method === "thread/settings/update" && rejected.has(threadId)) {
          ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "Thread not loaded" } }));
          return;
        }
        const queue = queues.get(threadId) ?? [];
        queues.set(threadId, queue);
        let result: unknown;
        switch (method) {
          case "thread/settings/update":
            updates.push(params);
            settings.set(threadId, params);
            result = {};
            break;
          case "thread/read": result = { thread: { status: { type: states.get(threadId) ?? "idle" } } }; break;
          case "thread/queue/list": result = { data: [...queue], nextCursor: null }; break;
          case "thread/queue/add": {
            const entry = { id: crypto.randomUUID(), clientUserMessageId: String(params.clientUserMessageId), input: params.input };
            queue.push(entry);
            result = { queuedSubmission: entry };
            events.emit("added", { threadId, wakeId: entry.clientUserMessageId } satisfies Added);
            break;
          }
          case "thread/queue/delete": {
            const index = queue.findIndex((entry) => entry.id === params.queuedSubmissionId);
            if (index >= 0) queue.splice(index, 1);
            result = { deleted: index >= 0 };
            break;
          }
          default: throw new Error(`unexpected RPC ${method}`);
        }
        ws.send(JSON.stringify({ id: message.id, result }));
      },
    },
  });
  cleanups.push(() => rpc.stop(true));
  const fake = startFakeDiscord();
  cleanups.push(() => fake.stop());
  writePrivateFile(join(home, "session.json"), JSON.stringify(legacy));
  writePrivateFile(join(home, "channels.json"), JSON.stringify({
    channels: [ORIGINAL, NITRO].map((channelId) => ({ channelId, guildId: fake.guildId })), dms: true,
  }));
  const launch = async (): Promise<BridgeHandle> => {
    const bridge = await startBridge({
      env: { HENT_HOME: home, CODEX_HOME: codexHome, HENT_DISCORD_TOKEN: "fake", HENT_DISCORD_API_BASE: fake.apiBase, HENT_DISCORD_GATEWAY: fake.gatewayUrl },
      port: 0, logSink: () => {},
      deliver: { isLive: async (session) => !unavailable.has(session.sessionId), retryMs: 60_000 },
    });
    cleanups.push(() => bridge.stop());
    await waitForEvent(bridge.events, "synced");
    return bridge;
  };
  const bridge = await launch();
  const api = (path: string, body?: unknown, target = bridge) => fetch(`http://127.0.0.1:${target.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${target.secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const register = (value: unknown = nitro, target = bridge) => api("/v1/session", value, target);
  const added = (threadId: string) => waitForEvent<Added>(events, "added", (entry) => entry.threadId === threadId);
  const next = (wake: Added, target = bridge) => api(`/v1/inbox/pending?${new URLSearchParams({ sessionId: wake.threadId, wakeId: wake.wakeId })}`, undefined, target);
  return { home, bridge, fake, settings, updates, rejected, unavailable, states, requests, queues, launch, api, register, added, next };
}

test("separate thread settings and drains route Nitro without changing the original or DMs", async () => {
  // Given separate registered brains on the real bridge HTTP and RPC transports.
  const h = await setup();
  const originalFile = readFileSync(join(h.home, "session.json"), "utf8");
  expect((await h.register({ ...nitro, configureCodex: true })).status).toBe(204);
  const originalWake = h.added("original");
  const nitroWake = h.added("nitro");
  const dmJournaled = waitForEvent<InboxEvent>(h.bridge.events, "journaled", (event) => event.messageId === "dm-message");
  // When a mixed burst arrives.
  const originalMessage = h.fake.addMessage(ORIGINAL, { content: "original" });
  const nitroMessage = h.fake.addMessage(NITRO, { content: "nitro" });
  h.fake.dispatch("MESSAGE_CREATE", {
    id: "dm-message", channel_id: "dm", author: { id: "person", username: "person" },
    content: "dm", timestamp: new Date().toISOString(), attachments: [],
  });
  const [original, scoped] = await Promise.all([originalWake, nitroWake]);
  await dmJournaled;
  // Then each wake reads only its partition, and only Nitro settings changed.
  expect(await (await h.next(original)).json()).toMatchObject({ events: [{ messageId: originalMessage.id }, { messageId: "dm-message" }] });
  expect(await (await h.next(scoped)).json()).toMatchObject({ events: [{ messageId: nitroMessage.id }] });
  expect(h.updates).toEqual([{
    threadId: "nitro", model: "gpt-6.1-sol", effort: "medium",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [h.home], networkAccess: true },
  }]);
  expect(h.settings.get("original")).toEqual({ model: "gpt-6.1-sol", effort: "low" });
  expect(readFileSync(join(h.home, "session.json"), "utf8")).toBe(originalFile);
  expect(statSync(join(h.home, "channel-sessions.json")).mode & 0o777).toBe(0o600);
  expect((await h.next({ ...scoped, threadId: "original" })).status).toBe(409);
  expect((await h.next({ ...original, threadId: "nitro" })).status).toBe(409);
  await h.api("/v1/handled", { messageId: nitroMessage.id, how: "skipped" });
  expect(await (await h.api("/v1/inbox/drained", { wakeId: scoped.wakeId, sessionId: "nitro" })).json()).toEqual({ continue: false });
  expect(await (await h.api("/v1/inbox/drained", { wakeId: original.wakeId, sessionId: "original" })).json()).toEqual({ continue: true });
});

test("an offline override never falls back and does not block the default lane", async () => {
  // Given Nitro's pane is offline after registration.
  const h = await setup();
  h.unavailable.add("nitro");
  expect((await h.register()).status).toBe(204);
  const originalWake = h.added("original");
  const nitroJournaled = waitForEvent<InboxEvent>(h.bridge.events, "journaled", (event) => event.channelId === NITRO);
  // When both channels receive messages.
  h.fake.addMessage(NITRO, { content: "wait for my brain" });
  const originalMessage = h.fake.addMessage(ORIGINAL, { content: "still responsive" });
  const wake = await originalWake;
  await nitroJournaled;
  // Then Nitro remains pending for its own session and the original drains alone.
  expect(await (await h.next(wake)).json()).toMatchObject({ events: [{ messageId: originalMessage.id }] });
  expect(h.queues.get("nitro") ?? []).toEqual([]);
  const nitroWake = h.added("nitro");
  h.unavailable.delete("nitro");
  await h.register();
  expect(await (await h.next(await nitroWake)).json()).toMatchObject({ events: [{ channelId: NITRO }] });
});

test("restart reuses each durable wake and session partition without duplicate enqueue", async () => {
  // Given both lanes have queued unhandled messages.
  const h = await setup();
  await h.register();
  const originalWake = h.added("original");
  const nitroWake = h.added("nitro");
  h.fake.addMessage(ORIGINAL, { content: "original" });
  h.fake.addMessage(NITRO, { content: "nitro" });
  const [original, scoped] = await Promise.all([originalWake, nitroWake]);
  await h.next(original);
  await h.next(scoped);
  h.states.set("original", "active");
  h.states.set("nitro", "active");
  // When the bridge restarts with the same journal and registration files.
  await h.bridge.stop();
  const restarted = await h.launch();
  // Then stale ownership is not merged, and receipt survives without new adds.
  expect(await (await h.next(original, restarted)).json()).toMatchObject({ events: [{ channelId: ORIGINAL }] });
  expect(await (await h.next(scoped, restarted)).json()).toMatchObject({ events: [{ channelId: NITRO }] });
  expect(h.requests.filter((request) => request.method === "thread/queue/add")).toHaveLength(2);
});

test.each(["thread", "pane"])("registration refuses a shared %s before changing any Codex settings", async (collision) => {
  // Given the legacy session still owns its thread and pane.
  const h = await setup();
  // When an override tries to reuse either identity.
  const response = await h.register({ ...nitro, ...(collision === "thread" ? { sessionId: "original" } : { pane: "w1:p1" }) });
  // Then the default configuration and dispatch ownership remain untouched.
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "session_conflict" });
  expect(h.updates).toEqual([]);
  expect(existsSync(join(h.home, "channel-sessions.json"))).toBe(false);
});

test("a rejected settings update keeps the previous channel session and model", async () => {
  // Given an established override.
  const h = await setup();
  await h.register();
  const previous = readFileSync(join(h.home, "channel-sessions.json"), "utf8");
  h.rejected.add("replacement");
  // When the replacement thread cannot be configured.
  const response = await h.register({ ...nitro, sessionId: "replacement", pane: "w3:p1", effort: "high" });
  // Then pending Nitro work still goes to the previous medium thread.
  expect(response.status).toBe(503);
  expect(readFileSync(join(h.home, "channel-sessions.json"), "utf8")).toBe(previous);
  const wake = h.added("nitro");
  h.fake.addMessage(NITRO, { content: "still medium" });
  expect(await (await h.next(await wake)).json()).toMatchObject({ events: [{ channelId: NITRO }] });
  expect(h.settings.get("nitro")).toMatchObject({ effort: "medium" });
});

test("a default re-registration cannot steal an override thread", async () => {
  // Given a dedicated Nitro registration.
  const h = await setup();
  await h.register();
  // When an unscoped registration attempts to claim that thread.
  const response = await h.register({ ...legacy, sessionId: "nitro", pane: "w3:p1", configureCodex: true });
  // Then the original registration and Nitro settings survive.
  expect(response.status).toBe(409);
  expect(h.updates).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(h.home, "session.json"), "utf8"))).toEqual(legacy);
});

test("a received default batch must drain before its channel transfers", async () => {
  // Given the default session already fetched Nitro work.
  const h = await setup();
  const wake = h.added("original");
  h.fake.addMessage(NITRO, { content: "already being answered" });
  await h.next(await wake);
  // When channel isolation is configured mid-reply.
  const response = await h.register();
  // Then no second brain can also receive that message.
  expect(response.status).toBe(409);
  expect(h.updates).toEqual([]);
  expect(existsSync(join(h.home, "channel-sessions.json"))).toBe(false);
});

test("legacy session replacement still recovers received but unhandled work", async () => {
  // Given a default brain stopped after fetching its pending batch.
  const h = await setup();
  const firstWake = h.added("original");
  const message = h.fake.addMessage(ORIGINAL, { content: "unfinished" });
  const old = await firstWake;
  await h.next(old);
  const replacementWake = h.added("replacement");
  // When a replacement is registered in the same default lane.
  expect((await h.register({ ...legacy, sessionId: "replacement", pane: "w3:p1" })).status).toBe(204);
  // Then existing recovery semantics replay unhandled work to the replacement.
  expect(await (await h.next(await replacementWake)).json()).toMatchObject({ events: [{ messageId: message.id }] });
  expect((await h.next(old)).status).toBe(409);
  expect(h.updates).toEqual([]);
});

test.each([
  { ...legacy, model: "gpt-6.1-sol", effort: "medium" },
  { ...nitro, model: undefined },
  { ...nitro, effort: undefined },
  { ...nitro, channelId: "../escape" },
  { ...nitro, effort: "" },
])("invalid or unscoped model routing is rejected at the API boundary: %j", (request) => {
  // Given malformed routing; when parsed; then it cannot reach thread setup.
  expect(parseSessionRequest(request).ok).toBe(false);
});
