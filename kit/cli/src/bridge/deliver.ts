// Push delivery (plan todo 9, ADR-0002 "Push delivery"): every journaled inbound message in a
// reply/ambient channel (or an allowed DM) is injected into the brain session, one at a time in
// seq order. The brain is an interactive Claude Code or Codex session in a herdr pane: herdr reports
// whether the agent is idle, `herdr agent prompt` submits the line, and a user-input record in the
// session transcript confirms it. While no live agent answers in the registered pane, events stay
// queued and are retried with backoff, so nothing is lost while the session restarts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../run.ts";
import type { InboxEvent, SessionRequest } from "./contract.ts";
import { appendPrivateLine, type BridgeLog, type HandledLedger, type Journal } from "./journal.ts";

export type ExecResult = { readonly code: number; readonly stdout: string };
export type Exec = (argv: readonly string[], opts?: { readonly cwd?: string; readonly timeoutMs?: number }) => Promise<ExecResult>;

export const realExec: Exec = async (argv, opts = {}) => {
  let proc;
  try {
    proc = Bun.spawn([...argv], { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: 127, stdout: "" };
  }
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout };
};

export type ChannelModeLookup = (channelId: string, guildId: string | null) => "reply" | "ambient" | "observe" | null;

export type DeliverDeps = {
  readonly journal: Journal;
  readonly handled: HandledLedger;
  readonly sessionPath: string;
  readonly deliveredPath: string;
  readonly channelMode: ChannelModeLookup;
  readonly clock: Clock;
  readonly log: BridgeLog;
  readonly exec?: Exec;
  readonly findTranscript?: (session: StoredSession) => string | null;
  readonly backoffMs?: readonly number[];
  readonly paneConfirmMs?: number;
  readonly staleUnhandledMs?: number;
  readonly busyRetryMs?: number;
};

export type StoredSession = SessionRequest & { readonly updatedAt?: string };

type DeliveredRecord = { readonly messageId: string; readonly seq: number; readonly mode: "pane"; readonly at: string };

const HISTORY_GAP_MS = 10 * 60_000;
const BUSY_RETRY_MS = 2_000;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SGR = /\x1b\[([0-9;]*)m/y;
const OTHER_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** Visible characters of one screen line, each flagged when drawn dim or grey (placeholder hints, not typed input). */
const styledChars = (line: string): { ch: string; dim: boolean }[] => {
  const out: { ch: string; dim: boolean }[] = [];
  let dim = false;
  for (let i = 0; i < line.length; ) {
    SGR.lastIndex = i;
    const sgr = SGR.exec(line);
    if (sgr) {
      const params = sgr[1]!.split(";");
      for (let k = 0; k < params.length; k += 1) {
        const p = params[k] === "" ? "0" : params[k]!;
        if (p === "0" || p === "22" || p === "39") dim = false;
        if (p === "2" || p === "90") dim = true;
        if ((p === "38" || p === "48") && params[k + 1] === "5") {
          if (p === "38" && /^24\d$/.test(params[k + 2] ?? "")) dim = true;
          k += 2;
        } else if ((p === "38" || p === "48") && params[k + 1] === "2") k += 4;
      }
      i = SGR.lastIndex;
      continue;
    }
    OTHER_ESCAPE.lastIndex = i;
    if (OTHER_ESCAPE.exec(line)) {
      i = OTHER_ESCAPE.lastIndex;
      continue;
    }
    out.push({ ch: line[i]!, dim });
    i += 1;
  }
  return out;
};

/**
 * Reads the agent's input line (the last ">", "›" (Codex) or "❯" (Claude Code 2.x) prompt on screen): "empty", "typed" when it
 * already holds text, or "none" when no prompt is visible (the agent is busy or it is not an agent).
 */
export const inputLine = (screen: string): "empty" | "typed" | "none" => {
  const lines = screen.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const chars = styledChars(lines[i]!.replace(/\r/g, ""));
    const start = chars.findIndex((c) => !/[\s│|]/.test(c.ch));
    if (start === -1 || !/[>›❯]/.test(chars[start]!.ch)) continue;
    const typed = chars
      .slice(start + 1)
      .filter((c) => !c.dim)
      .map((c) => c.ch)
      .join("")
      .replace(/[\s│|]+/g, " ")
      .trim();
    return typed.length > 0 ? "typed" : "empty";
  }
  return "none";
};

/**
 * True while the agent is mid-turn. Claude Code and Codex both keep an empty input line while working
 * (typed text is queued), so emptiness alone is not idleness; both show "esc to interrupt" in the
 * live status area at the bottom of the screen until the turn ends.
 */
export const agentWorking = (screen: string): boolean =>
  screen
    .split("\n")
    .map((line) => line.replace(ANSI, ""))
    .filter((line) => line.trim().length > 0)
    .slice(-6)
    .some((line) => /esc to interrupt/i.test(line));

type JsonObject = { readonly [key: string]: unknown };
const asObject = (value: unknown): JsonObject | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null);

/** Texts of a transcript record that is user input: Claude `{type:"user",message}`, Codex `{payload:{role:"user"}}` or `user_message`. */
const userInputTexts = (record: unknown): string[] => {
  const r = asObject(record);
  if (!r) return [];
  const payload = asObject(r.payload);
  const message = asObject(r.message);
  let content: unknown;
  if (r.type === "user" && message?.role === "user") content = message.content;
  else if (payload?.role === "user") content = payload.content;
  else if (payload?.type === "user_message") content = payload.message;
  else return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.map((part) => asObject(part)?.text).filter((text): text is string => typeof text === "string");
};

export const inboundLine = (event: InboxEvent): string => `[hent] INBOUND ${JSON.stringify(event)}`;

/** True when `chunk` (JSONL) holds a user-input record containing exactly the injected INBOUND line for `event`. */
export const transcriptReceived = (chunk: string, event: InboxEvent): boolean => {
  const line = inboundLine(event);
  for (const raw of chunk.split("\n")) {
    if (!raw.includes(event.messageId)) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (userInputTexts(record).some((text) => text.includes(line))) return true;
  }
  return false;
};
const HISTORY_COUNT = 30;

export const readSession = (path: string): StoredSession | null => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as StoredSession;
    return typeof value.sessionId === "string" && typeof value.pane === "string" && (value.agent === "claude" || value.agent === "codex") ? value : null;
  } catch {
    return null;
  }
};

const walkFind = (dir: string, match: (name: string) => boolean, depth = 5): string | null => {
  if (depth < 0 || !existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const found = st.isDirectory() ? walkFind(path, match, depth - 1) : match(name) ? path : null;
    if (found) {
      const mtime = statSync(found).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: found, mtime };
    }
  }
  return best?.path ?? null;
};

/** Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl; Codex: ~/.codex/sessions/**\/rollout-*<sessionId>*.jsonl. */
export const defaultFindTranscript = (session: StoredSession, home = homedir()): string | null =>
  session.agent === "claude"
    ? walkFind(join(home, ".claude", "projects"), (n) => n === `${session.sessionId}.jsonl`, 2)
    : walkFind(join(home, ".codex", "sessions"), (n) => n.endsWith(".jsonl") && n.includes(session.sessionId));

export const formatPrompt = (event: InboxEvent, history: readonly InboxEvent[]): string => {
  const slim = (e: InboxEvent) => ({ messageId: e.messageId, author: e.authorName, self: e.authorIsSelf, content: e.content, at: e.createdAt });
  const historyPart = history.length > 0 ? `[hent] HISTORY ${JSON.stringify(history.map(slim))} ` : "";
  return `${historyPart}${inboundLine(event)}`;
};

export class Deliverer {
  private readonly queue: InboxEvent[] = [];
  private readonly delivered = new Map<string, DeliveredRecord>();
  private readonly reinjected = new Set<string>();
  private readonly lastDeliveredAt = new Map<string, number>();
  private readonly exec: Exec;
  private readonly findTranscript: (session: StoredSession) => string | null;
  private sessionEpoch = 0;
  private running = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly injected = new Map<string, { readonly path: string | null; readonly offset: number }>();
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DeliverDeps) {
    this.exec = deps.exec ?? realExec;
    this.findTranscript = deps.findTranscript ?? ((s) => defaultFindTranscript(s));
    try {
      for (const line of readFileSync(deps.deliveredPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as DeliveredRecord;
        if (typeof record.messageId === "string") this.delivered.set(record.messageId, record);
      }
    } catch {
      this.delivered.clear();
    }
  }

  eligible(event: InboxEvent): boolean {
    if (event.kind !== "message_create" || event.authorIsSelf) return false;
    const mode = this.deps.channelMode(event.channelId, event.guildId);
    if (mode === null || mode === "observe") return false;
    return !this.deps.handled.get(event.messageId);
  }

  start(): void {
    for (const event of this.deps.journal.after(0, Number.MAX_SAFE_INTEGER)) {
      if (this.eligible(event) && !this.delivered.has(event.messageId)) this.queue.push(event);
    }
    this.staleTimer = setInterval(() => this.checkStale(), 60_000);
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.wake?.();
  }

  onJournaled(event: InboxEvent): void {
    if (!this.eligible(event) || this.delivered.has(event.messageId)) return;
    if (this.queue.some((e) => e.messageId === event.messageId)) return;
    this.queue.push(event);
    this.kick();
  }

  onSessionSet(): void {
    this.reinjected.clear();
    this.sessionEpoch += 1;
    const pending = this.deps.journal
      .after(0, Number.MAX_SAFE_INTEGER)
      .filter((e) => this.delivered.has(e.messageId) && this.eligible(e) && !this.reinjected.has(e.messageId));
    for (const event of pending) {
      this.reinjected.add(event.messageId);
      this.delivered.delete(event.messageId);
      if (!this.queue.some((e) => e.messageId === event.messageId)) this.queue.push(event);
    }
    this.queue.sort((a, b) => a.seq - b.seq);
    if (pending.length > 0) this.deps.log("BRIDGE_REINJECT", { count: pending.length });
    this.wake?.();
    this.kick();
  }

  pendingCount(): number {
    return this.queue.length;
  }

  private checkStale(): void {
    const session = readSession(this.deps.sessionPath);
    if (!session) return;
    const staleMs = this.deps.staleUnhandledMs ?? 10 * 60_000;
    void this.paneAgent(session.pane, session.agent).then((state) => {
      if (state !== "gone") return;
      const now = this.deps.clock.now();
      for (const record of this.delivered.values()) {
        if (this.reinjected.has(record.messageId)) continue;
        if (now - Date.parse(record.at) < staleMs || this.deps.handled.get(record.messageId)) continue;
        const event = this.deps.journal.findCreate(record.messageId);
        if (!event) continue;
        this.reinjected.add(record.messageId);
        this.delivered.delete(record.messageId);
        this.queue.push(event);
      }
      this.queue.sort((a, b) => a.seq - b.seq);
      this.kick();
    });
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.loop().finally(() => {
      this.running = false;
      if (this.queue.length > 0 && !this.stopped) this.kick();
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = null;
  }

  private async loop(): Promise<void> {
    const backoff = this.deps.backoffMs ?? [5_000, 30_000, 120_000, 300_000];
    let attempt = 0;
    let epoch = this.sessionEpoch;
    while (!this.stopped && this.queue.length > 0) {
      // A fresh `hent session set` starts the backoff over: the new session gets a prompt attempt.
      if (epoch !== this.sessionEpoch) {
        epoch = this.sessionEpoch;
        attempt = 0;
      }
      const event = this.queue[0]!;
      if (!this.eligible(event)) {
        this.queue.shift();
        continue;
      }
      const result = await this.deliverOne(event);
      if (result.ok) {
        this.queue.shift();
        attempt = 0;
        continue;
      }
      const delay = result.reason === "pane_busy" ? (this.deps.busyRetryMs ?? BUSY_RETRY_MS) : backoff[Math.min(attempt, backoff.length - 1)]!;
      this.deps.log("BRIDGE_DELIVER_RETRY", { messageId: event.messageId, reason: result.reason, delayMs: delay });
      if (result.reason !== "pane_busy") attempt += 1;
      await this.sleep(delay);
    }
  }

  private historyFor(event: InboxEvent): InboxEvent[] {
    const last = this.lastDeliveredAt.get(event.channelId);
    if (last !== undefined && this.deps.clock.now() - last < HISTORY_GAP_MS) return [];
    return this.deps.journal.history(event.channelId, HISTORY_COUNT + 1).filter((e) => e.seq < event.seq).slice(-HISTORY_COUNT);
  }

  private record(event: InboxEvent): void {
    const record: DeliveredRecord = { messageId: event.messageId, seq: event.seq, mode: "pane", at: new Date(this.deps.clock.now()).toISOString() };
    this.delivered.set(event.messageId, record);
    this.injected.delete(event.messageId);
    this.lastDeliveredAt.set(event.channelId, this.deps.clock.now());
    appendPrivateLine(this.deps.deliveredPath, JSON.stringify(record));
    this.deps.log("BRIDGE_DELIVERED", { messageId: event.messageId, seq: event.seq, pane: true });
  }

  /**
   * "ok" when herdr sees the registered agent idle in the pane with an empty input line; "busy" while
   * it works, waits on a question, or holds text the user is typing; "gone" when no such agent is there.
   */
  private async paneAgent(pane: string, agent: StoredSession["agent"]): Promise<"ok" | "gone" | "busy"> {
    const res = await this.exec(["herdr", "agent", "get", pane], { timeoutMs: 5_000 });
    if (res.code !== 0) return "gone";
    let info: JsonObject | null = null;
    try {
      info = asObject(asObject(asObject(JSON.parse(res.stdout))?.result)?.agent);
    } catch {
      info = null;
    }
    if (!info || info.agent !== agent) return "gone";
    if (info.agent_status !== "idle" && info.agent_status !== "done") return "busy";
    const screen = await this.exec(["herdr", "agent", "read", pane, "--source", "visible", "--format", "ansi"], { timeoutMs: 5_000 });
    if (screen.code !== 0) return "gone";
    return !agentWorking(screen.stdout) && inputLine(screen.stdout) === "empty" ? "ok" : "busy";
  }

  private async deliverOne(event: InboxEvent): Promise<{ ok: true } | { ok: false; reason: string }> {
    const session = readSession(this.deps.sessionPath);
    if (!session) return { ok: false, reason: "no_session" };
    // An earlier injection the agent queued instead of reading at once: confirm it, never type it twice.
    if (this.receivedEarlier(session, event)) {
      this.record(event);
      return { ok: true };
    }
    const state = await this.paneAgent(session.pane, session.agent);
    if (state === "busy") return { ok: false, reason: "pane_busy" };
    if (state === "gone") return { ok: false, reason: "no_agent_in_pane" };
    if (await this.deliverPane(session, formatPrompt(event, this.historyFor(event)), event)) {
      this.record(event);
      return { ok: true };
    }
    return { ok: false, reason: "pane_unconfirmed" };
  }

  private receivedSince(path: string | null, offset: number, event: InboxEvent): boolean {
    if (this.deps.handled.get(event.messageId)) return true;
    if (!path || !existsSync(path) || statSync(path).size <= offset) return false;
    // `offset` is a byte size; slice the bytes, not the decoded string (multi-byte text shifts char offsets).
    return transcriptReceived(readFileSync(path).subarray(offset).toString("utf8"), event);
  }

  private receivedEarlier(session: StoredSession, event: InboxEvent): boolean {
    const prior = this.injected.get(event.messageId);
    if (!prior) return false;
    return this.receivedSince(prior.path ?? this.findTranscript(session), prior.path ? prior.offset : 0, event);
  }

  private async deliverPane(session: StoredSession, prompt: string, event: InboxEvent): Promise<boolean> {
    const transcript = this.findTranscript(session);
    const before = transcript && existsSync(transcript) ? statSync(transcript).size : 0;
    this.injected.set(event.messageId, { path: transcript, offset: before });
    // herdr submits through the agent surface: bracketed paste, then Enter once the paste settled.
    if ((await this.exec(["herdr", "agent", "prompt", session.pane, prompt], { timeoutMs: 15_000 })).code !== 0) return false;
    const deadline = this.deps.clock.now() + (this.deps.paneConfirmMs ?? 10_000);
    while (this.deps.clock.now() < deadline) {
      if (this.receivedEarlier(session, event)) return true;
      await this.deps.clock.sleep(250);
    }
    return false;
  }
}
