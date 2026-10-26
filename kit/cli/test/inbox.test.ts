import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessingInbox, StaleWakeError } from "../src/bridge/inbox.ts";
import { bridgePaths, ensurePrivateDir, HandledLedger, Journal, writePrivateFile } from "../src/bridge/journal.ts";
import { MAX_INBOX_EVENTS, type SessionRequest } from "../src/bridge/contract.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = Date.parse("2026-10-15T00:00:00Z");
const session: SessionRequest = { agent: "codex", sessionId: "session-1", pane: "w1:p1", cwd: "/tmp" };

function setup() {
  const home = mkdtempSync(join(tmpdir(), "hent-inbox-"));
  dirs.push(home);
  const paths = bridgePaths(home);
  ensurePrivateDir(paths.state);
  writePrivateFile(paths.session, JSON.stringify(session));
  const journal = Journal.open(paths, now, () => {});
  const handled = HandledLedger.open(paths.handled, now);
  const deps = { journal, handled, sessionPath: paths.session, wakePath: join(paths.state, "native-wake.json"), isBridged: (channel: string) => channel !== "disabled", log: () => {} };
  const inbox = new ProcessingInbox(deps);
  const append = (id: string, channelId = "room", authorIsSelf = false) => journal.append({
    kind: "message_create", channelId, guildId: "guild", messageId: id, authorId: "author", authorName: "owner",
    authorIsSelf, authorIsBot: authorIsSelf, content: `message ${id}\n$(id)`, referencedMessageId: null,
    attachments: [], createdAt: new Date(now).toISOString(),
  });
  const prepare = () => {
    const wake = inbox.prepare(session.sessionId);
    if (!wake) throw new Error("fixture requires pending work");
    return wake;
  };
  return { inbox, append, prepare, deps, paths };
}

test("pending batches preserve order and exclude self, disabled and handled events", () => {
  const h = setup();
  h.append("self", "room", true);
  h.append("off", "disabled");
  h.append("done");
  h.deps.handled.mark({ messageId: "done", how: "skipped", at: new Date(now).toISOString() });
  for (let i = 0; i <= MAX_INBOX_EVENTS; i++) h.append(`pending-${i}`, i % 2 ? "other" : "room");
  const events = h.inbox.next(h.prepare()).events;
  expect(events.map((event) => event.messageId)).toEqual(Array.from({ length: MAX_INBOX_EVENTS }, (_, i) => `pending-${i}`));
  expect(h.deps.handled.get("pending-0")).toBeUndefined();
});

test("a received wake survives restart and replays only unhandled messages", () => {
  const h = setup();
  h.append("one");
  h.append("two");
  const wake = h.prepare();
  h.inbox.next(wake);
  h.deps.handled.mark({ messageId: "one", how: "replied", at: new Date(now).toISOString() });
  const restarted = new ProcessingInbox({
    ...h.deps,
    journal: Journal.open(h.paths, now, () => {}),
    handled: HandledLedger.open(h.paths.handled, now),
  });
  expect(restarted.active()?.phase).toBe("received");
  expect(restarted.next(wake).events.map((event) => event.messageId)).toEqual(["two"]);
  expect(restarted.done(wake)).toEqual({ continue: true });
});

test("a late queue response cannot undo a received wake", () => {
  const h = setup();
  h.append("one");
  const wake = h.prepare();
  h.inbox.next(wake);
  h.inbox.queued(wake.wakeId, "native-entry");
  expect(h.inbox.active()).toMatchObject({ phase: "received", queuedSubmissionId: "native-entry" });
  expect(h.inbox.pending().map((event) => event.messageId)).toEqual(["one"]);
});

test("an arrival at drain completion stays with this wake or its successor", () => {
  const h = setup();
  h.append("one");
  const wake = h.prepare();
  h.inbox.next(wake);
  h.deps.handled.mark({ messageId: "one", how: "skipped", at: new Date(now).toISOString() });
  h.append("before-done");
  expect(h.inbox.done(wake)).toEqual({ continue: true });
  h.deps.handled.mark({ messageId: "before-done", how: "skipped", at: new Date(now).toISOString() });
  expect(h.inbox.done(wake)).toEqual({ continue: false });
  h.append("after-done");
  const successor = h.prepare();
  expect(successor.wakeId).not.toBe(wake.wakeId);
  expect(() => h.inbox.done(wake)).toThrow(StaleWakeError);
  expect(h.inbox.next(successor).events.map((event) => event.messageId)).toEqual(["after-done"]);
});

test("wrong sessions and completion without a read cannot claim or retire work", () => {
  const h = setup();
  h.append("one");
  const wake = h.prepare();
  expect(() => h.inbox.next({ ...wake, sessionId: "another" })).toThrow(StaleWakeError);
  expect(() => h.inbox.done(wake)).toThrow(StaleWakeError);
  expect(h.inbox.active()?.phase).toBe("prepared");
  writePrivateFile(h.paths.session, JSON.stringify({ ...session, sessionId: "replacement" }));
  expect(() => h.inbox.next(wake)).toThrow(StaleWakeError);
  expect(h.inbox.pending().map((event) => event.messageId)).toEqual(["one"]);
});
