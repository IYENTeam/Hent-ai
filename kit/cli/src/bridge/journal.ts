// Bridge storage (ADR-0002): private file helpers, the append-only inbound journal,
// per-channel cursors, consumer cursors/leases, and the sent/handled ledgers.
// Everything under HENT_HOME is created with dirs 0700 and files 0600 (the journal holds
// message content). Appends are fsynced; whole-file rewrites go through tmp + rename.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CONSUMER_LEASE_TTL_MS, type ConsumerStatus, type HandledHow, type InboxEvent, JOURNAL_RETENTION_MS, parseInboxEvent } from "./contract.ts";

export type BridgeLog = (event: string, fields?: Readonly<Record<string, string | number | boolean | null>>) => void;

export type BridgePaths = {
  readonly home: string;
  readonly state: string;
  readonly inbox: string;
  readonly journalState: string;
  readonly sent: string;
  readonly handled: string;
  readonly consumers: string;
  readonly secret: string;
  readonly discordToken: string;
  readonly channels: string;
  readonly session: string;
};

export const bridgePaths = (home: string): BridgePaths => {
  const state = join(home, "state");
  return {
    home,
    state,
    inbox: join(state, "inbox.jsonl"),
    journalState: join(state, "journal-state.json"),
    sent: join(state, "sent.jsonl"),
    handled: join(state, "handled.jsonl"),
    consumers: join(state, "consumers"),
    secret: join(home, "bridge.secret"),
    discordToken: join(home, "discord.token"),
    channels: join(home, "channels.json"),
    session: join(home, "session.json"),
  };
};

export const ensurePrivateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

/** Atomic whole-file write: tmp file (0600, fsynced) renamed over the target. */
export const writePrivateFile = (path: string, data: string): void => {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};

/** Appends one line and fsyncs before returning. */
export const appendPrivateLine = (path: string, line: string): void => {
  const fd = openSync(path, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Parses a JSONL file. A torn final line (crash mid-append) is counted in `bad`, not thrown. */
const readJsonl = (path: string): { items: unknown[]; bad: number } => {
  if (!existsSync(path)) return { items: [], bad: 0 };
  const items: unknown[] = [];
  let bad = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { items, bad };
};

const readJsonFile = (path: string): unknown => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const rewriteJsonl = (path: string, rows: readonly unknown[]): void => writePrivateFile(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));

/** Orders Discord snowflakes numerically; non-numeric fixture ids fall back to length-then-lexical. */
export const compareIds = (a: string, b: string): number => {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
};

export type NewInboxEvent = Omit<InboxEvent, "seq">;

const eventKey = (e: NewInboxEvent): string => {
  if (e.kind === "message_create") return `c:${e.messageId}`;
  if (e.kind === "message_delete") return `d:${e.messageId}`;
  return `u:${e.messageId}:${e.createdAt}`;
};

type JournalState = { lastSeq?: unknown; channels?: unknown };

/**
 * Append-only inbound journal (`state/inbox.jsonl`). `seq` is strictly increasing and survives
 * retention compaction via `state/journal-state.json`, which also holds each channel's newest
 * journaled (or seeded) message id - the backfill/seed cursor.
 */
export class Journal {
  private readonly events: InboxEvent[] = [];
  private readonly keys = new Set<string>();
  private readonly creates = new Map<string, InboxEvent>();
  private readonly channels = new Map<string, string>();
  private readonly listeners = new Set<(event: InboxEvent) => void>();
  private seq = 0;

  private constructor(private readonly paths: BridgePaths) {}

  /** Loads the journal and drops events older than the 7-day retention window. */
  static open(paths: BridgePaths, now: number, log: BridgeLog): Journal {
    const journal = new Journal(paths);
    const { items, bad } = readJsonl(paths.inbox);
    const cutoff = now - JOURNAL_RETENTION_MS;
    const kept: InboxEvent[] = [];
    let invalid = bad;
    let maxSeq = 0;
    for (const raw of items) {
      const parsed = parseInboxEvent(raw);
      if (!parsed.ok) {
        invalid++;
        continue;
      }
      maxSeq = Math.max(maxSeq, parsed.value.seq);
      if (Date.parse(parsed.value.createdAt) >= cutoff) kept.push(parsed.value);
    }
    const state = (readJsonFile(paths.journalState) ?? {}) as JournalState;
    const savedSeq = typeof state.lastSeq === "number" && Number.isSafeInteger(state.lastSeq) ? state.lastSeq : 0;
    journal.seq = Math.max(maxSeq, savedSeq);
    if (state.channels && typeof state.channels === "object") {
      for (const [channelId, messageId] of Object.entries(state.channels as Record<string, unknown>)) {
        if (typeof messageId === "string") journal.channels.set(channelId, messageId);
      }
    }
    kept.sort((a, b) => a.seq - b.seq);
    for (const event of kept) journal.index(event);
    const compacted = items.length + bad - kept.length;
    if (compacted > 0 || !existsSync(paths.inbox)) rewriteJsonl(paths.inbox, kept);
    journal.saveState();
    log("BRIDGE_JOURNAL_OPEN", { events: kept.length, compacted, invalidLines: invalid, lastSeq: journal.seq });
    return journal;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Journals one event unless it was already journaled (resume replay, backfill overlap). */
  append(event: NewInboxEvent): InboxEvent | null {
    const key = eventKey(event);
    if (this.keys.has(key)) return null;
    const stored: InboxEvent = { seq: this.seq + 1, ...event };
    appendPrivateLine(this.paths.inbox, JSON.stringify(stored));
    this.seq = stored.seq;
    this.index(stored);
    this.saveState();
    for (const listener of this.listeners) listener(stored);
    return stored;
  }

  onAppend(listener: (event: InboxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves on the next append, after `ms`, or when `signal` aborts - whichever is first. */
  waitForAppend(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      let off = (): void => {};
      const done = (): void => {
        clearTimeout(timer);
        off();
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      off = this.onAppend(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  after(cursor: number, max: number): InboxEvent[] {
    const out: InboxEvent[] = [];
    for (const event of this.events) {
      if (event.seq <= cursor) continue;
      out.push(event);
      if (out.length >= max) break;
    }
    return out;
  }

  /** Newest `limit` events of a channel, newest last. */
  history(channelId: string, limit: number): InboxEvent[] {
    return this.events.filter((e) => e.channelId === channelId).slice(-limit);
  }

  findCreate(messageId: string): InboxEvent | undefined {
    return this.creates.get(messageId);
  }

  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  channelCursor(channelId: string): string | undefined {
    return this.channels.get(channelId);
  }

  /** First start per channel: remember the newest message id ("0" for an empty channel), journal nothing. */
  seedChannel(channelId: string, newestMessageId: string): boolean {
    if (this.channels.has(channelId)) return false;
    this.channels.set(channelId, newestMessageId);
    this.saveState();
    return true;
  }

  private index(event: InboxEvent): void {
    this.keys.add(eventKey(event));
    this.events.push(event);
    if (event.kind !== "message_create") return;
    this.creates.set(event.messageId, event);
    const current = this.channels.get(event.channelId);
    if (current === undefined || compareIds(event.messageId, current) > 0) this.channels.set(event.channelId, event.messageId);
  }

  private saveState(): void {
    writePrivateFile(this.paths.journalState, JSON.stringify({ lastSeq: this.seq, channels: Object.fromEntries(this.channels) }));
  }
}

/**
 * Consumer cursors (`state/consumers/<name>.json`) and in-memory 60 s leases.
 */
export class ConsumerStore {
  private readonly leases = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly now: () => number,
  ) {}

  cursor(name: string): number {
    const raw = readJsonFile(join(this.dir, `${name}.json`)) as { cursor?: unknown } | undefined;
    return typeof raw?.cursor === "number" && Number.isSafeInteger(raw.cursor) && raw.cursor >= 0 ? raw.cursor : 0;
  }

  setCursor(name: string, cursor: number): void {
    writePrivateFile(join(this.dir, `${name}.json`), JSON.stringify({ cursor }));
  }

  renewLease(name: string): void {
    this.leases.set(name, this.now() + CONSUMER_LEASE_TTL_MS);
  }

  list(): ConsumerStatus[] {
    const names = existsSync(this.dir)
      ? readdirSync(this.dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -".json".length))
      : [];
    for (const name of this.leases.keys()) if (!names.includes(name)) names.push(name);
    return names.sort().map((name) => {
      const expires = this.leases.get(name);
      return { name, cursor: this.cursor(name), leaseExpiresAt: expires !== undefined && expires > this.now() ? new Date(expires).toISOString() : null };
    });
  }
}

const loadRecords = <T extends { at: string }>(path: string, now: number, valid: (r: unknown) => r is T): T[] => {
  const { items, bad } = readJsonl(path);
  const cutoff = now - JOURNAL_RETENTION_MS;
  const kept = items.filter(valid).filter((r) => Date.parse(r.at) >= cutoff);
  if (kept.length !== items.length + bad || !existsSync(path)) rewriteJsonl(path, kept);
  return kept;
};

export type SentRecord = { readonly nonce: string; readonly messageId: string; readonly channelId: string; readonly at: string };

const isSentRecord = (r: unknown): r is SentRecord => {
  const o = r as Partial<SentRecord> | null;
  return typeof o?.nonce === "string" && typeof o.messageId === "string" && typeof o.channelId === "string" && typeof o.at === "string";
};

/** `state/sent.jsonl`, keyed by nonce: a repeated nonce returns the original message id. */
export class SentLedger {
  private readonly byNonce = new Map<string, SentRecord>();

  private constructor(private readonly path: string) {}

  static open(path: string, now: number): SentLedger {
    const ledger = new SentLedger(path);
    for (const r of loadRecords(path, now, isSentRecord)) ledger.byNonce.set(r.nonce, r);
    return ledger;
  }

  get(nonce: string): SentRecord | undefined {
    return this.byNonce.get(nonce);
  }

  record(record: SentRecord): void {
    appendPrivateLine(this.path, JSON.stringify(record));
    this.byNonce.set(record.nonce, record);
  }
}

export type HandledRecord = { readonly messageId: string; readonly how: HandledHow; readonly at: string };

const isHandledRecord = (r: unknown): r is HandledRecord => {
  const o = r as Partial<HandledRecord> | null;
  return typeof o?.messageId === "string" && (o.how === "replied" || o.how === "skipped") && typeof o.at === "string";
};

/** `state/handled.jsonl`: inbound messages the session replied to or deliberately skipped. */
export class HandledLedger {
  private readonly byMessage = new Map<string, HandledRecord>();

  private constructor(private readonly path: string) {}

  static open(path: string, now: number): HandledLedger {
    const ledger = new HandledLedger(path);
    for (const r of loadRecords(path, now, isHandledRecord)) ledger.byMessage.set(r.messageId, r);
    return ledger;
  }

  get(messageId: string): HandledRecord | undefined {
    return this.byMessage.get(messageId);
  }

  /** Returns false when the message was already handled (the first outcome wins). */
  mark(record: HandledRecord): boolean {
    if (this.byMessage.has(record.messageId)) return false;
    appendPrivateLine(this.path, JSON.stringify(record));
    this.byMessage.set(record.messageId, record);
    return true;
  }
}
