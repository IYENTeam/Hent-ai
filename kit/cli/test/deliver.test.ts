import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxEvent } from "../src/bridge/contract.ts";
import { Deliverer, defaultFindTranscript, type Exec, formatPrompt, headlessArgv, inputLine, type StoredSession, transcriptReceived } from "../src/bridge/deliver.ts";
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
  // The fake pane agent writes where Claude Code does: <HOME>/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
  const sessionId = session?.sessionId ?? "none";
  const projectDir = join(home, ".claude", "projects", "-tmp");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "이전 대화: 한글 응답이 길게 쌓여 있다 ".repeat(200) } })}\n`);
  let typedLine = "";
  let paneScreen: string | null = null;
  let herdrPane: { agent: string; agent_status: string } | null = { agent: "claude", agent_status: "idle" };
  const calls: string[][] = [];
  let paneAlive = true;
  let headlessCode = 0;
  let headlessHandles = true;
  let paneWrites = true;
  let paneInput = "";
  let paneCommand = "claude";
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "tmux" && argv[1] === "display-message") return { code: paneAlive ? 0 : 1, stdout: paneAlive ? `0 ${paneCommand}\n` : "" };
    const screen = () => paneScreen ?? `some output\n\x1b[2m-- hint --\x1b[0m\n> ${paneInput}\n`;
    const submit = (line: string) => {
      // A pane that "does not write" still produces agent output quoting the line, which must not count as receipt.
      const record = paneWrites ? { type: "user", message: { role: "user", content: line } } : { type: "assistant", message: { role: "assistant", content: `echo: ${line}` } };
      appendFileSync(transcript, `${JSON.stringify(record)}\n`);
    };
    if (argv[0] === "tmux" && argv[1] === "capture-pane") return { code: 0, stdout: screen() };
    if (argv[0] === "tmux" && argv[1] === "send-keys" && argv[4] === "-l") typedLine = argv[5]!;
    if (argv[0] === "tmux" && argv[1] === "send-keys" && argv[4] === "Enter") submit(typedLine);
    if (argv[0] === "herdr" && argv[2] === "get") return herdrPane ? { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: argv[3], ...herdrPane } } }) } : { code: 1, stdout: "" };
    if (argv[0] === "herdr" && argv[2] === "read") return { code: 0, stdout: screen() };
    if (argv[0] === "herdr" && argv[2] === "run") submit(argv[4]!);
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
  const logLines: string[] = [];
  const deliverer = new Deliverer({
    journal,
    handled,
    sessionPath: paths.session,
    deliveredPath: join(paths.state, "delivered.jsonl"),
    channelMode: () => opts.mode ?? "reply",
    clock: realClock,
    log: (name: string, fields?: Record<string, unknown>) => logLines.push(`${name} ${JSON.stringify(fields ?? {})}`),
    exec,
    findTranscript: (s: StoredSession) => defaultFindTranscript(s, home),
    backoffMs: [5],
    paneConfirmMs: 500,
    busyRetryMs: 10,
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
    setPaneInput: (text: string) => (paneInput = text),
    setPaneCommand: (cmd: string) => (paneCommand = cmd),
    setPaneScreen: (text: string | null) => (paneScreen = text),
    setHerdrPane: (info: { agent: string; agent_status: string } | null) => (herdrPane = info),
    appendTranscript: (record: unknown) => appendFileSync(transcript, `${JSON.stringify(record)}\n`),
    setHeadless: (code: number, handles = true) => {
      headlessCode = code;
      headlessHandles = handles;
    },
    injected: () => calls.filter((c) => (c[0] === "tmux" && c[4] === "-l") || (c[0] === "herdr" && c[2] === "run")).map((c) => (c[0] === "tmux" ? c[5]! : c[4]!)),
    headless: () => calls.filter((c) => c[0] === "claude" || c[0] === "codex"),
    logs: () => logLines,
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

test("confirmation reads only bytes written after injection, even after multi-byte text", async () => {
  const h = harness(pane);
  h.journal.append(event("m1", "안녕"));
  await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED") || l.includes("pane_unconfirmed")));
  expect(h.logs().some((l) => l.includes("pane_unconfirmed"))).toBe(false);
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

test("each hent session set re-injects still-unhandled events once; replied ones never", async () => {
  const h = harness(pane);
  h.journal.append(event("m1", "unanswered"));
  h.journal.append(event("m2", "answered"));
  await settle(h, () => h.injected().length === 2);
  h.handled.mark({ messageId: "m2", how: "replied", at: new Date().toISOString() });
  h.deliverer.onSessionSet();
  await settle(h, () => h.injected().length === 3);
  expect(h.injected()[2]).toContain('"messageId":"m1"');
  h.deliverer.onSessionSet();
  await settle(h, () => h.injected().length === 4);
  expect(h.injected()[3]).toContain('"messageId":"m1"');
  h.handled.mark({ messageId: "m1", how: "skipped", at: new Date().toISOString() });
  h.deliverer.onSessionSet();
  await Bun.sleep(50);
  expect(h.injected().length).toBe(4);
  h.deliverer.stop();
});

test("a pane with unfinished typed input waits, then delivers once the input is empty", async () => {
  const h = harness(pane);
  h.setPaneInput("half-typed thought");
  h.journal.append(event("m1", "hi"));
  await Bun.sleep(80);
  expect(h.injected()).toEqual([]);
  expect(h.headless()).toEqual([]);
  h.setPaneInput("");
  await settle(h, () => h.injected().length === 1);
  h.deliverer.stop();
});

test("a pane running another program (vim) is never typed into", async () => {
  const h = harness(pane);
  h.setPaneCommand("vim");
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.headless().length >= 1);
  expect(h.injected()).toEqual([]);
  h.deliverer.stop();
});

test("inputLine tells an empty prompt from typed input and from no prompt at all", () => {
  expect(inputLine("│ > \x1b[2mTry \"fix lint\"\x1b[0m   │")).toBe("empty");
  expect(inputLine("> ")).toBe("empty");
  expect(inputLine("› draft reply")).toBe("typed");
  expect(inputLine("│ > typed │")).toBe("typed");
  expect(inputLine("unrelated node server is running")).toBe("none");
});

test("inputLine reads a real Claude Code 2.1 screen (❯ prompt, dim placeholder)", () => {
  const screen = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1-screen-${name}.ansi`, import.meta.url), "utf8");
  expect(inputLine(screen("empty"))).toBe("empty");
  expect(inputLine(screen("typed"))).toBe("typed");
});

test("a pane showing no input prompt is treated as busy, never typed into", async () => {
  const h = harness(pane);
  h.setPaneScreen("compiling...\nstill working");
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_busy")));
  expect(h.injected()).toEqual([]);
  expect(h.headless()).toEqual([]);
  h.deliverer.stop();
});

test("an unrelated node process in a codex pane is not taken for the agent", async () => {
  const h = harness({ ...pane, agent: "codex" });
  h.setPaneCommand("node");
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.headless().length >= 1);
  expect(h.injected()).toEqual([]);
  h.deliverer.stop();
});

test("assistant text that mentions the INBOUND marker and id does not confirm receipt", () => {
  const prompt = formatPrompt({ ...event("wanted-id", "payload"), seq: 1 } as InboxEvent, []);
  const assistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: `I saw [hent] INBOUND earlier; wanted-id is pending. ${prompt}` } });
  expect(transcriptReceived(assistant, "wanted-id")).toBe(false);
  expect(transcriptReceived(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }), "wanted-id")).toBe(true);
  const codexUser = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });
  expect(transcriptReceived(codexUser, "wanted-id")).toBe(true);
});

test("typing without a submitted user record leaves the event unconfirmed", async () => {
  const h = harness(pane);
  h.setPaneWrites(false);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_unconfirmed")));
  expect(h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED"))).toBe(false);
  h.deliverer.stop();
});

test("a herdr pane is used through herdr: idle agent gets the line, a working agent waits", async () => {
  const h = harness({ ...pane, pane: "w1:p7" });
  h.setHerdrPane({ agent: "claude", agent_status: "working" });
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_busy")));
  expect(h.injected()).toEqual([]);
  h.setHerdrPane({ agent: "claude", agent_status: "idle" });
  await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED")));
  expect(h.calls.filter((c) => c[0] === "herdr" && c[2] === "run").map((c) => c[3])).toEqual(["w1:p7"]);
  expect(h.calls.some((c) => c[0] === "tmux")).toBe(false);
  h.deliverer.stop();
});

test("a herdr pane running a different agent falls back to headless", async () => {
  const h = harness({ ...pane, pane: "w1:p7" });
  h.setHerdrPane({ agent: "codex", agent_status: "idle" });
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.headless().length >= 1);
  expect(h.injected()).toEqual([]);
  h.deliverer.stop();
});

test("transcripts are found where Claude Code and Codex write them", () => {
  const home = mkdtempSync(join(tmpdir(), "hent-find-"));
  dirs.push(home);
  const claude = join(home, ".claude", "projects", "-Users-me-brain");
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, "aaaa-bbbb.jsonl"), "");
  const codex = join(home, ".codex", "sessions", "2026", "10", "14");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "rollout-2026-10-14T00-50-01-cccc-dddd.jsonl"), "");
  expect(defaultFindTranscript({ agent: "claude", sessionId: "aaaa-bbbb", mode: "pane", pane: "%1", cwd: "/x" }, home)).toBe(join(claude, "aaaa-bbbb.jsonl"));
  expect(defaultFindTranscript({ agent: "codex", sessionId: "cccc-dddd", mode: "pane", pane: "%1", cwd: "/x" }, home)).toBe(join(codex, "rollout-2026-10-14T00-50-01-cccc-dddd.jsonl"));
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
