// The journal is the work queue. This snapshot owns only one coalesced wake,
// never a message's replied/skipped outcome.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MAX_INBOX_EVENTS, parseSessionRequest, type InboxEvent, type SessionRequest } from "./contract.ts";
import { type BridgeLog, type HandledLedger, type Journal, writePrivateFile } from "./journal.ts";

export type WakeRequest = { readonly wakeId: string; readonly sessionId: string };
export type NativeWake = WakeRequest & {
  readonly phase: "prepared" | "queued" | "received";
  readonly queuedSubmissionId: string | null;
};
export type BridgedLookup = (channelId: string, guildId: string | null) => boolean;
export class StaleWakeError extends Error {}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;

export function readSession(path: string): SessionRequest | null {
  if (!existsSync(path)) return null;
  try {
    const value = record(JSON.parse(readFileSync(path, "utf8")));
    if (!value) return null;
    const parsed = parseSessionRequest({ agent: value.agent, sessionId: value.sessionId, pane: value.pane, cwd: value.cwd });
    return parsed.ok ? parsed.value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export class ProcessingInbox {
  private wake: NativeWake | null = null;

  constructor(private readonly deps: {
    readonly journal: Journal;
    readonly handled: HandledLedger;
    readonly sessionPath: string;
    readonly getSession?: () => SessionRequest | null;
    readonly wakePath: string;
    readonly isBridged: BridgedLookup;
    readonly log: BridgeLog;
  }) {
    if (!existsSync(deps.wakePath)) return;
    const value = record(JSON.parse(readFileSync(deps.wakePath, "utf8")));
    if (value === null) return;
    if (typeof value.wakeId !== "string" || typeof value.sessionId !== "string" ||
      (value.phase !== "prepared" && value.phase !== "queued" && value.phase !== "received") ||
      (value.queuedSubmissionId !== null && typeof value.queuedSubmissionId !== "string")) {
      throw new Error("invalid native wake snapshot");
    }
    this.wake = {
      wakeId: value.wakeId, sessionId: value.sessionId, phase: value.phase,
      queuedSubmissionId: value.queuedSubmissionId,
    };
  }

  session(): SessionRequest | null { return this.deps.getSession ? this.deps.getSession() : readSession(this.deps.sessionPath); }
  active(): NativeWake | null { return this.wake; }

  eligible(event: InboxEvent): boolean {
    return event.kind === "message_create" && !event.authorIsSelf &&
      this.deps.isBridged(event.channelId, event.guildId) && !this.deps.handled.get(event.messageId);
  }

  pending(limit = MAX_INBOX_EVENTS): InboxEvent[] {
    return this.deps.journal.after(0, Number.MAX_SAFE_INTEGER).filter((event) => this.eligible(event)).slice(0, limit);
  }

  prepare(sessionId: string): NativeWake | null {
    if (this.wake) return this.wake;
    if (this.pending(1).length === 0) return null;
    const wake: NativeWake = { wakeId: randomUUID(), sessionId, phase: "prepared", queuedSubmissionId: null };
    this.save(wake);
    return wake;
  }

  queued(wakeId: string, queuedSubmissionId: string): void {
    if (this.wake?.wakeId !== wakeId) return;
    this.save({ ...this.wake, phase: this.wake.phase === "received" ? "received" : "queued", queuedSubmissionId });
  }

  retry(wakeId: string): void {
    if (this.wake?.wakeId === wakeId) this.save({ ...this.wake, phase: "prepared", queuedSubmissionId: null });
  }

  next(request: WakeRequest): { events: InboxEvent[] } {
    const wake = this.requireCurrent(request);
    if (wake.phase !== "received") this.save({ ...wake, phase: "received" });
    const events = this.pending();
    this.deps.log("BRIDGE_INBOX_RECEIVED", { wakeId: wake.wakeId, count: events.length });
    return { events };
  }

  done(request: WakeRequest): { continue: boolean } {
    const wake = this.requireCurrent(request);
    if (wake.phase !== "received") throw new StaleWakeError("read the inbox before completing its wake");
    // No await between the pending check and retirement: an append either keeps
    // this wake alive or observes no owner and schedules its successor.
    if (this.pending(1).length > 0) return { continue: true };
    this.retire(wake.wakeId);
    return { continue: false };
  }

  retire(wakeId: string): void {
    if (this.wake?.wakeId !== wakeId) return;
    this.save(null);
    this.deps.log("BRIDGE_WAKE_RETIRED", { wakeId });
  }

  private requireCurrent(request: WakeRequest): NativeWake {
    const session = this.session();
    const wake = this.wake;
    if (!session || !wake || session.sessionId !== request.sessionId ||
      wake.sessionId !== request.sessionId || wake.wakeId !== request.wakeId) {
      throw new StaleWakeError("wake does not belong to the registered session");
    }
    return wake;
  }

  private save(wake: NativeWake | null): void {
    writePrivateFile(this.deps.wakePath, `${JSON.stringify(wake)}\n`);
    this.wake = wake;
  }
}
