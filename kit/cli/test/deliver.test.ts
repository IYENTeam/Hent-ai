import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxEvent } from "../src/bridge/contract.ts";
import { Deliverer, type Exec, formatPrompt, headlessArgv, type StoredSession } from "../src/bridge/deliver.ts";
import { bridgePaths, ensurePrivateDir, HandledLedger, Journal, type NewInboxEvent } from "../src/bridge/journal.ts";
import { realClock } from "../src/run.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const event = (messageId: string, content: string, over: Partial<NewInboxEvent> = {}): NewInboxEvent => ({
  kind: "message_create",
  channelId: "100000000000000001",
  guildId: "900000000000000001",
  messageId,
  authorId: "700000000000000001",
  authorIsBot: false,
  authorIsSelf: false,
  authorName: "owner",
  content,
  referencedMessageId: null,
  attachments: [],
  createdAt: new Date().toISOString(),
  ...over,
});

type Harness = ReturnType<typeof harness>;

const harness = (session: StoredSession | null, opts: { mode?: "reply" | "ambient" | "observe" } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "hent-deliver-"));
  dirs.push(home);
  const paths = bridgePaths(home);
  ensurePrivateDir(home);
  ensurePrivateDir(paths.state);
  if (session) writeFileSync(paths.session, JSON.stringify(session));
  const journal = Journal.open(paths, Date.now(), () => {});
  const handled = HandledLedger.open(paths.handled, Date.now());
  const transcript = join(home, "transcript.jsonl");
  writeFileSync(transcript, "");
  const calls: string[][] = [];
  let paneAlive = true;
  let headlessCode = 0;
  let headlessHandles = true;
  let paneWrites = true;
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "tmux" && argv[1] === "display-message") return { code: paneAlive ? 0 : 1, stdout: paneAlive ? "0 claude\n" : "" };
    if (argv[0] === "tmux" && argv[1] === "send-keys" && argv[4] === "-l" && paneWrites) appendFileSync(transcript, `${JSON.stringify({ input: argv[5] })}\n`);
    if (argv[0] === "claude" || argv[0] === "codex") {
      if (headlessCode === 0 && headlessHandles) {
        const prompt = argv.find((a) => a.includes("[hent] INBOUND"))!;
        const id = JSON.parse(prompt.slice(prompt.indexOf("[hent] INBOUND ") + 15)).messageId as string;
        handled.mark({ messageId: id, how: "skipped", at: new Date().toISOString() });
      }
      return { code: headlessCode, stdout: "" };
    }
    return { code: 0, stdout: "" };
  };
  const deliverer = new Deliverer({
    journal,
    handled,
    sessionPath: paths.session,
    deliveredPath: join(paths.state, "delivered.jsonl"),
    channelMode: () => opts.mode ?? "reply",
    clock: realClock,
    log: () => {},
    exec,
    findTranscript: () => transcript,
    backoffMs: [5],
    paneConfirmMs: 500,
  });
  journal.onAppend((e) => deliverer.onJournaled(e));
  deliverer.start();
  return {
    home,
    paths,
    journal,
    handled,
    deliverer,
    calls,
    setPane: (alive: boolean) => (paneAlive = alive),
    setPaneWrites: (writes: boolean) => (paneWrites = writes),
    setHeadless: (code: number, handles = true) => {
      headlessCode = code;
      headlessHandles = handles;
    },
    injected: () => calls.filter((c) => c[0] === "tmux" && c[4] === "-l").map((c) => c[5]!),
    headless: () => calls.filter((c) => c[0] === "claude" || c[0] === "codex"),
  };
};

const settle = async (h: Harness, predicate: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
  h.deliverer.pendingCount();
};

const pane: StoredSession = { agent: "claude", sessionId: "11111111-2222-3333-4444-555555555555", mode: "pane", pane: "%1", cwd: "/tmp" };
const headlessSession: StoredSession = { agent: "claude", sessionId: "11111111-2222-3333-4444-555555555555", mode: "headless", pane: null, cwd: "/tmp" };

test("three events are injected into the pane in seq order", async () => {
  const h = harness(pane);
  h.journal.append(event("m1", "first"));
  h.journal.append(event("m2", "second"));
  h.journal.append(event("m3", "third"));
  await settle(h, () => h.injected().length === 3);
  expect(h.injected().map((p) => JSON.parse(p.slice(p.indexOf("[hent] INBOUND ") + 15)).messageId)).toEqual(["m1", "m2", "m3"]);
  h.deliverer.stop();
});

test("self messages and observe channels are never injected", async () => {
  const h = harness(pane, { mode: "observe" });
  h.journal.append(event("m1", "hello"));
  const h2 = harness(pane);
  h2.journal.append(event("s1", "mine", { authorIsSelf: true, authorIsBot: true }));
  await Bun.sleep(50);
  expect(h.injected()).toEqual([]);
  expect(h2.injected()).toEqual([]);
  h.deliverer.stop();
  h2.deliverer.stop();
});

test("a dead pane falls back to a headless resumed turn that must handle the event", async () => {
  const h = harness(pane);
  h.setPane(false);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.handled.get("m1") !== undefined && h.deliverer.pendingCount() === 0);
  const argv = h.headless()[0]!;
  expect(argv.slice(0, 4)).toEqual(["claude", "-p", "--resume", pane.sessionId]);
  expect(argv.at(-1)).toBe("--allowedTools=Bash(hent:*)");
  h.deliverer.stop();
});

test("headless exit 1 is retried and the event is delivered exactly once", async () => {
  const h = harness(headlessSession);
  h.setHeadless(1);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.headless().length >= 2);
  h.setHeadless(0);
  await settle(h, () => h.deliverer.pendingCount() === 0);
  await Bun.sleep(30);
  const successes = h.headless().length;
  expect(successes).toBeGreaterThanOrEqual(3);
  expect(h.handled.get("m1")?.how).toBe("skipped");
  await Bun.sleep(30);
  expect(h.headless().length).toBe(successes);
  h.deliverer.stop();
});

test("a headless turn that exits 0 without handling the event stays pending", async () => {
  const h = harness(headlessSession);
  h.setHeadless(0, false);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.headless().length >= 2);
  expect(h.deliverer.pendingCount()).toBe(1);
  h.deliverer.stop();
});

test("a pane delivery is confirmed from the transcript, otherwise retried", async () => {
  const h = harness(pane);
  h.setPaneWrites(false);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.injected().length >= 2, 4000);
  h.setPaneWrites(true);
  await settle(h, () => h.deliverer.pendingCount() === 0, 4000);
  h.deliverer.stop();
});

test("bridge restart resumes undelivered events and does not repeat delivered ones", async () => {
  const h = harness(pane);
  h.journal.append(event("m1", "one"));
  await settle(h, () => h.injected().length === 1);
  h.deliverer.stop();
  h.setPane(false);
  h.journal.append(event("m2", "two"));
  const journal2 = Journal.open(h.paths, Date.now(), () => {});
  const calls: string[][] = [];
  const d2 = new Deliverer({
    journal: journal2,
    handled: h.handled,
    sessionPath: h.paths.session,
    deliveredPath: join(h.paths.state, "delivered.jsonl"),
    channelMode: () => "reply",
    clock: realClock,
    log: () => {},
    exec: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "tmux" && argv[1] === "display-message") return { code: 1, stdout: "" };
      if (argv[0] === "claude") h.handled.mark({ messageId: "m2", how: "replied", at: new Date().toISOString() });
      return { code: 0, stdout: "" };
    },
    backoffMs: [5],
  });
  d2.start();
  await settle(h, () => h.handled.get("m2") !== undefined);
  const prompts = calls.filter((c) => c[0] === "claude").map((c) => c[4]!);
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain('"messageId":"m2"');
  d2.stop();
});

test("an unhandled event is re-injected once after hent session set; a replied one is not", async () => {
  const h = harness(pane);
  h.journal.append(event("m1", "unanswered"));
  h.journal.append(event("m2", "answered"));
  await settle(h, () => h.injected().length === 2);
  h.handled.mark({ messageId: "m2", how: "replied", at: new Date().toISOString() });
  h.deliverer.onSessionSet();
  await settle(h, () => h.injected().length === 3);
  expect(h.injected()[2]).toContain('"messageId":"m1"');
  h.deliverer.onSessionSet();
  await Bun.sleep(50);
  expect(h.injected().length).toBe(3);
  h.deliverer.stop();
});

test("prompt text carries quotes, newlines and $( verbatim as one argv element", () => {
  const e: InboxEvent = { seq: 1, ...event("m1", 'say "hi"\nthen $(id) `x`') };
  const prompt = formatPrompt(e, []);
  expect(prompt.includes("\n")).toBe(false);
  expect(JSON.parse(prompt.slice(prompt.indexOf("[hent] INBOUND ") + 15)).content).toBe('say "hi"\nthen $(id) `x`');
  const argv = headlessArgv(headlessSession, prompt);
  expect(argv[4]).toBe(prompt);
  const codex = headlessArgv({ ...headlessSession, agent: "codex" }, prompt);
  expect(codex.slice(0, 4)).toEqual(["codex", "exec", "resume", "--skip-git-repo-check"]);
  expect(codex.at(-1)).toBe(prompt);
});

test("history is prefixed after a quiet gap", () => {
  mkdirSync(tmpdir(), { recursive: true });
  const e: InboxEvent = { seq: 3, ...event("m3", "now") };
  const prior: InboxEvent = { seq: 2, ...event("m2", "earlier") };
  const prompt = formatPrompt(e, [prior]);
  expect(prompt.startsWith("[hent] HISTORY ")).toBe(true);
  expect(prompt).toContain('"content":"earlier"');
});
