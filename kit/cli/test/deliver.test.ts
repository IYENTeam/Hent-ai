import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxEvent } from "../src/bridge/contract.ts";
import { agentWorking, Deliverer, defaultFindTranscript, type Exec, formatPrompt, inboundLine, inputLine, type StoredSession, transcriptReceived } from "../src/bridge/deliver.ts";
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
type FakeAgent = { agent: string; agent_status: string } | null;

const harness = (session: StoredSession | null, opts: { mode?: "reply" | "ambient" | "observe"; backoffMs?: number[] } = {}) => {
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
  // Fake herdr: `agent get` reports the pane occupant, `agent read` the screen, `agent prompt` submits a line.
  let agent: FakeAgent = { agent: session?.agent ?? "claude", agent_status: "idle" };
  let paneScreen: string | null = null;
  let paneInput = "";
  let paneWrites = true;
  let promptFails = false;
  let queueInput = false;
  const queued: string[] = [];
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    if (argv[0] !== "herdr" || argv[1] !== "agent") return { code: 127, stdout: "" };
    if (argv[2] === "get") return agent ? { code: 0, stdout: JSON.stringify({ result: { agent: { pane_id: argv[3], ...agent }, type: "agent_info" } }) } : { code: 1, stdout: "" };
    if (argv[2] === "read") return { code: agent ? 0 : 1, stdout: paneScreen ?? `some output\n\x1b[2m-- hint --\x1b[0m\n> ${paneInput}\n` };
    if (argv[2] === "prompt") {
      if (promptFails || !agent) return { code: 1, stdout: "" };
      const line = argv[4]!;
      // A working agent queues the submitted line and writes its user record only when it reads it.
      if (queueInput) queued.push(line);
      else {
        // A pane that "does not write" still produces agent output quoting the line, which must not count as receipt.
        const record = paneWrites ? { type: "user", message: { role: "user", content: line } } : { type: "assistant", message: { role: "assistant", content: `echo: ${line}` } };
        appendFileSync(transcript, `${JSON.stringify(record)}\n`);
      }
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
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
    backoffMs: opts.backoffMs ?? [5],
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
    setAgent: (next: FakeAgent) => (agent = next),
    setPaneWrites: (writes: boolean) => (paneWrites = writes),
    setPaneInput: (text: string) => (paneInput = text),
    setPaneScreen: (text: string | null) => (paneScreen = text),
    setPromptFails: (fails: boolean) => (promptFails = fails),
    setQueueInput: (on: boolean) => (queueInput = on),
    readQueued: () => {
      for (const line of queued.splice(0)) appendFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: line } })}\n`);
    },
    injected: () => calls.filter((c) => c[0] === "herdr" && c[2] === "prompt").map((c) => c[4]!),
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

const pane: StoredSession = { agent: "claude", sessionId: "11111111-2222-3333-4444-555555555555", pane: "w1:p1", cwd: "/tmp" };

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

test("with no live agent in the pane, events stay queued (never run elsewhere) until it is back", async () => {
  const h = harness(pane);
  h.setAgent(null);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().filter((l) => l.includes("no_agent_in_pane")).length >= 2);
  expect(h.injected()).toEqual([]);
  expect(h.calls.every((c) => c[0] === "herdr")).toBe(true);
  h.setAgent({ agent: "claude", agent_status: "idle" });
  h.deliverer.onSessionSet();
  await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED")));
  expect(h.injected().length).toBe(1);
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
      if (argv[2] === "get") return { code: 0, stdout: JSON.stringify({ result: { agent: { agent: "claude", agent_status: "idle" } } }) };
      if (argv[2] === "read") return { code: 0, stdout: "> \n" };
      if (argv[2] === "prompt") h.handled.mark({ messageId: "m2", how: "replied", at: new Date().toISOString() });
      return { code: 0, stdout: "" };
    },
    backoffMs: [5],
  });
  d2.start();
  await settle(h, () => h.handled.get("m2") !== undefined);
  const prompts = calls.filter((c) => c[2] === "prompt").map((c) => c[4]!);
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
  h.setPaneInput("");
  await settle(h, () => h.injected().length === 1);
  h.deliverer.stop();
});

test("a pane where herdr sees another agent is never typed into", async () => {
  const h = harness(pane);
  h.setAgent({ agent: "codex", agent_status: "idle" });
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("no_agent_in_pane")));
  expect(h.injected()).toEqual([]);
  h.deliverer.stop();
});

test("an agent herdr reports as working or blocked on a question waits", async () => {
  for (const status of ["working", "blocked", "unknown"]) {
    const h = harness(pane);
    h.setAgent({ agent: "claude", agent_status: status });
    h.journal.append(event("m1", "hi"));
    await settle(h, () => h.logs().some((l) => l.includes("pane_busy")));
    expect(h.injected()).toEqual([]);
    h.setAgent({ agent: "claude", agent_status: "done" });
    await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED")));
    expect(h.injected().length).toBe(1);
    h.deliverer.stop();
  }
});

test("a rejected herdr prompt is retried, not counted as delivered", async () => {
  const h = harness(pane);
  h.setPromptFails(true);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_unconfirmed")));
  expect(h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED"))).toBe(false);
  h.setPromptFails(false);
  await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED")));
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

test("hent session set restarts the backoff, so the new session is tried right away", async () => {
  const h = harness(pane, { backoffMs: [5, 60_000] });
  rmSync(h.paths.session);
  h.journal.append(event("m1", "while away"));
  await settle(h, () => h.logs().filter((l) => l.includes("no_session")).length >= 2);
  writeFileSync(h.paths.session, JSON.stringify(pane));
  h.setPaneWrites(false);
  h.deliverer.onSessionSet();
  await settle(h, () => h.logs().some((l) => l.includes("pane_unconfirmed")));
  expect(h.logs().find((l) => l.includes("pane_unconfirmed"))).toContain('"delayMs":5');
  h.setPaneWrites(true);
  await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED")), 1_000);
  h.deliverer.stop();
});

test("agentWorking spots the live 'esc to interrupt' status of Claude Code and Codex", () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  expect(agentWorking(fixture("claude-2.1-screen-working.ansi"))).toBe(true);
  expect(agentWorking(fixture("codex-0.162-screen-working.ansi"))).toBe(true);
  expect(agentWorking(fixture("claude-2.1-screen-empty.ansi"))).toBe(false);
  expect(inputLine(fixture("claude-2.1-screen-working.ansi"))).toBe("empty");
  expect(inputLine(fixture("codex-0.162-screen-working.ansi"))).toBe("empty");
});

test("an agent that is mid-turn with an empty input line is busy, never typed into", async () => {
  const h = harness(pane);
  h.setPaneScreen(readFileSync(new URL("./fixtures/claude-2.1-screen-working.ansi", import.meta.url), "utf8"));
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_busy")));
  expect(h.injected()).toEqual([]);
  h.setPaneScreen(null);
  await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED")));
  expect(h.injected().length).toBe(1);
  h.deliverer.stop();
});

test("a line the agent queued past the confirm window is confirmed later, not typed twice", async () => {
  const h = harness(pane);
  h.setQueueInput(true);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_unconfirmed")));
  h.readQueued();
  await settle(h, () => h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED")));
  expect(h.injected().length).toBe(1);
  h.deliverer.stop();
});

test("a pane showing no input prompt is treated as busy, never typed into", async () => {
  const h = harness(pane);
  h.setPaneScreen("compiling...\nstill working");
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_busy")));
  expect(h.injected()).toEqual([]);
  h.deliverer.stop();
});

test("receipt needs the exact injected line in a user-input record", () => {
  const wanted = { ...event("wanted-id", "payload"), seq: 1 } as InboxEvent;
  const prompt = formatPrompt(wanted, []);
  const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
  const assistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: prompt } });
  expect(transcriptReceived(assistant, wanted)).toBe(false);
  expect(transcriptReceived(user('I saw [hent] INBOUND earlier; {"messageId":"wanted-id"} is pending'), wanted)).toBe(false);
  expect(transcriptReceived(user(inboundLine({ ...wanted, content: "other payload" })), wanted)).toBe(false);
  expect(transcriptReceived(user(prompt), wanted)).toBe(true);
  const codexUser = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });
  expect(transcriptReceived(codexUser, wanted)).toBe(true);
});

test("typing without a submitted user record leaves the event unconfirmed", async () => {
  const h = harness(pane);
  h.setPaneWrites(false);
  h.journal.append(event("m1", "hi"));
  await settle(h, () => h.logs().some((l) => l.includes("pane_unconfirmed")));
  expect(h.logs().some((l) => l.startsWith("BRIDGE_DELIVERED"))).toBe(false);
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
  expect(defaultFindTranscript({ agent: "claude", sessionId: "aaaa-bbbb", pane: "w1:p1", cwd: "/x" }, home)).toBe(join(claude, "aaaa-bbbb.jsonl"));
  expect(defaultFindTranscript({ agent: "codex", sessionId: "cccc-dddd", pane: "w1:p1", cwd: "/x" }, home)).toBe(join(codex, "rollout-2026-10-14T00-50-01-cccc-dddd.jsonl"));
});

test("prompt text carries quotes, newlines and $( verbatim as one herdr argv element", async () => {
  const content = 'say "hi"\nthen $(id) `x`';
  const prompt = formatPrompt({ seq: 1, ...event("m1", content) }, []);
  expect(prompt.includes("\n")).toBe(false);
  expect(JSON.parse(prompt.slice(prompt.indexOf("[hent] INBOUND ") + 15)).content).toBe(content);
  const h = harness(pane);
  h.journal.append(event("m1", content));
  await settle(h, () => h.injected().length === 1);
  const call = h.calls.find((c) => c[2] === "prompt")!;
  expect(call.slice(0, 4)).toEqual(["herdr", "agent", "prompt", "w1:p1"]);
  expect(call.length).toBe(5);
  expect(JSON.parse(call[4]!.slice(call[4]!.indexOf("[hent] INBOUND ") + 15)).content).toBe(content);
  h.deliverer.stop();
});

test("history is prefixed after a quiet gap", () => {
  mkdirSync(tmpdir(), { recursive: true });
  const e: InboxEvent = { seq: 3, ...event("m3", "now") };
  const prior: InboxEvent = { seq: 2, ...event("m2", "earlier") };
  const prompt = formatPrompt(e, [prior]);
  expect(prompt.startsWith("[hent] HISTORY ")).toBe(true);
  expect(prompt).toContain('"content":"earlier"');
});
