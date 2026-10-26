import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deliverer } from "../src/bridge/deliver.ts";
import { type QueueRpc, wakeText } from "../src/bridge/codex-queue.ts";
import { ProcessingInbox, readSession } from "../src/bridge/inbox.ts";
import { bridgePaths, ensurePrivateDir, HandledLedger, Journal, writePrivateFile } from "../src/bridge/journal.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const now = Date.parse("2026-10-15T00:00:00Z");
const session = { agent: "codex", sessionId: "thread-1", pane: "w1:p1", cwd: "/tmp" } as const;
type Entry = { id: string; clientUserMessageId: string; input: { type: string; text: string }[] };
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), "hent-wake-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = bridgePaths(home);
  ensurePrivateDir(paths.state);
  writePrivateFile(paths.session, JSON.stringify(session));
  const journal = Journal.open(paths, now, () => {});
  const handled = HandledLedger.open(paths.handled, now);
  const inboxDeps = { journal, handled, sessionPath: paths.session, wakePath: join(paths.state, "native-wake.json"), isBridged: (channel: string) => channel !== "off", log: () => {} };
  const inbox = new ProcessingInbox(inboxDeps);
  const entries: Entry[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  let state = "idle";
  let live = true;
  let failAfterAdd = false;
  let beforeList: (() => Promise<void>) | undefined;
  let connections = 0;
  const connect = async (): Promise<QueueRpc> => {
    connections++;
    const closed = new Set<() => void>();
    return {
      async request(method, params) {
        calls.push(method);
        const body = object(params);
        switch (method) {
          case "thread/read": return { thread: { status: { type: state } } };
          case "thread/queue/list":
            if (beforeList) await beforeList();
            return { data: [...entries], nextCursor: null };
          case "thread/queue/add": {
            if (typeof body.clientUserMessageId !== "string" || !Array.isArray(body.input)) throw new Error("invalid add");
            const entry: Entry = {
              id: randomUUID(), clientUserMessageId: body.clientUserMessageId,
              input: body.input.map((part) => { const value = object(part); return { type: String(value.type), text: String(value.text) }; }),
            };
            entries.push(entry); // Native IDs are deliberately NOT idempotent.
            if (failAfterAdd) throw new Error("accepted, response lost");
            return { queuedSubmission: entry };
          }
          case "thread/queue/delete": {
            const index = entries.findIndex((entry) => entry.id === body.queuedSubmissionId);
            if (index >= 0) entries.splice(index, 1);
            return { deleted: index >= 0 };
          }
          default: throw new Error(`unexpected request ${method}`);
        }
      },
      subscribe: () => () => {},
      onClose: (listener) => { closed.add(listener); return () => { closed.delete(listener); }; },
      close: () => { const callbacks = [...closed]; closed.clear(); for (const callback of callbacks) callback(); },
    };
  };
  const deps = { inbox, connect, isLive: async () => live, log: (event: string) => { logs.push(event); }, retryMs: 60_000 };
  const deliverer = new Deliverer(deps);
  cleanups.push(() => deliverer.stop());
  const append = (id: string, channelId = "room", authorIsSelf = false) => journal.append({
    kind: "message_create", messageId: id, channelId, guildId: "guild", authorId: "owner", authorName: "owner",
    authorIsSelf, authorIsBot: authorIsSelf, content: `raw "${id}"\n$(id) \`literal\``, attachments: [],
    referencedMessageId: null, createdAt: new Date(now).toISOString(),
  });
  const wake = () => { const value = inbox.active(); if (!value) throw new Error("missing wake"); return value; };
  return {
    inbox, inboxDeps, deliverer, deps, paths, entries, calls, logs, append, wake, handled,
    state: (value: string) => { state = value; },
    live: (value: boolean) => { live = value; },
    failAfterAdd: (value: boolean) => { failAfterAdd = value; },
    beforeList: (value: (() => Promise<void>) | undefined) => { beforeList = value; },
    connections: () => connections,
  };
}

test("a burst queues one small wake and preserves every raw message in order", async () => {
  const h = harness();
  h.append("one"); h.append("two"); h.append("three");
  await h.deliverer.onSessionSet();
  await h.deliverer.onSessionSet();
  expect(h.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
  expect(h.entries.map((entry) => entry.input)).toEqual([[{ type: "text", text: wakeText(h.wake().wakeId) }]]);
  expect(h.inbox.next(h.wake()).events.map((event) => [event.messageId, event.content])).toEqual(
    ["one", "two", "three"].map((id) => [id, `raw "${id}"\n$(id) \`literal\``]),
  );
});

test("self messages and unlisted channels never become pending wakes", async () => {
  const h = harness();
  h.append("self", "room", true); h.append("disabled", "off");
  await h.deliverer.onSessionSet();
  expect(h.entries).toEqual([]);
  expect(h.inbox.active()).toBeNull();
});

test("an absent pane does not connect or wake a headless thread", async () => {
  const h = harness();
  h.live(false); h.append("waiting");
  await h.deliverer.onSessionSet();
  expect(h.connections()).toBe(0);
  h.live(true);
  await h.deliverer.onSessionSet();
  expect(h.entries).toHaveLength(1);
});

test("an unloaded Codex thread is never resumed or started by delivery", async () => {
  const h = harness();
  h.state("notLoaded"); h.append("waiting");
  await h.deliverer.onSessionSet();
  expect(h.entries).toEqual([]);
  expect(h.calls).toEqual(["thread/read"]);
  h.state("idle");
  await h.deliverer.onSessionSet();
  expect(h.entries).toHaveLength(1);
});

test("a busy thread accepts one queued wake without steering its active turn", async () => {
  const h = harness();
  h.state("active"); h.append("one");
  await h.deliverer.onSessionSet();
  h.append("two");
  await h.deliverer.onSessionSet();
  expect(h.entries).toHaveLength(1);
  expect(h.calls.every((method) => ["thread/read", "thread/queue/list", "thread/queue/add"].includes(method))).toBe(true);
});

test("a lost add response is reconciled from the native queue without another add", async () => {
  const h = harness();
  h.failAfterAdd(true); h.append("one");
  await h.deliverer.onSessionSet();
  expect(h.entries).toHaveLength(1);
  expect(h.inbox.active()?.phase).toBe("prepared");
  h.failAfterAdd(false);
  await h.deliverer.onSessionSet();
  expect(h.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
  expect(h.inbox.active()?.phase).toBe("queued");
});

test("restart adopts the persisted wake and existing native entry", async () => {
  const h = harness();
  h.append("one");
  await h.deliverer.onSessionSet();
  await h.deliverer.stop();
  const restartedInbox = new ProcessingInbox(h.inboxDeps);
  const restarted = new Deliverer({ ...h.deps, inbox: restartedInbox });
  cleanups.push(() => restarted.stop());
  await restarted.onSessionSet();
  expect(restartedInbox.active()?.wakeId).toBe(h.wake().wakeId);
  expect(h.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
});

test("duplicate owned queue rows are removed while unrelated input survives", async () => {
  const h = harness();
  h.append("one");
  await h.deliverer.onSessionSet();
  const wake = h.wake();
  h.entries.push({ id: "duplicate", clientUserMessageId: wake.wakeId, input: [{ type: "text", text: wakeText(wake.wakeId) }] });
  h.entries.push({ id: "unrelated", clientUserMessageId: randomUUID(), input: [{ type: "text", text: "human input" }] });
  await h.deliverer.onSessionSet();
  expect(h.entries.map((entry) => entry.id)).not.toContain("duplicate");
  expect(h.entries.map((entry) => entry.id)).toContain("unrelated");
  expect(h.entries).toHaveLength(2);
});

test("received work is not requeued while its turn is active", async () => {
  const h = harness();
  h.append("one");
  await h.deliverer.onSessionSet();
  h.inbox.next(h.wake());
  h.entries.splice(0); h.state("active"); h.append("two");
  await h.deliverer.onHandled();
  expect(h.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
  expect(h.inbox.pending().map((event) => event.messageId)).toEqual(["one", "two"]);
});

test("a wake consumed between the idle snapshot and queue listing is not queued again", async () => {
  const h = harness();
  h.append("one");
  await h.deliverer.onSessionSet();
  h.beforeList(async () => {
    h.entries.splice(0);
    h.state("active");
    h.beforeList(undefined);
  });
  await h.deliverer.onSessionSet();
  expect(h.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
  expect(h.inbox.active()?.phase).toBe("queued");
});

test("completed work retires its wake and clears stale owned queue entries", async () => {
  const h = harness();
  h.append("one");
  await h.deliverer.onSessionSet();
  const wake = h.wake();
  h.inbox.next(wake);
  h.handled.mark({ messageId: "one", how: "skipped", at: new Date(now).toISOString() });
  h.inbox.done(wake);
  await h.deliverer.onInboxDrained();
  expect(h.entries).toEqual([]);
  expect(h.inbox.active()).toBeNull();
});

test("an arrival while a native snapshot is in flight is queued before the pump settles", async () => {
  const h = harness();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.beforeList(async () => { entered.resolve(); await release.promise; });
  const checking = h.deliverer.onSessionSet();
  await entered.promise;
  h.append("late");
  h.beforeList(undefined);
  release.resolve();
  await checking;
  expect(h.entries).toHaveLength(1);
  expect(h.inbox.next(h.wake()).events.map((event) => event.messageId)).toEqual(["late"]);
});

test("legacy Claude session records are rejected before native delivery", () => {
  const h = harness();
  writePrivateFile(h.paths.session, JSON.stringify({ ...session, agent: "claude" }));
  expect(readSession(h.paths.session)).toBeNull();
});
