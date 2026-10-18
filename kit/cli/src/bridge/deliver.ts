// Native queue entries are wakeups, not the work queue. Every source message
// remains pending until the existing send/skip ledger records its outcome.
import { homedir } from "node:os";
import { join } from "node:path";
import type { InboxEvent, SessionRequest } from "./contract.ts";
import { CodexRpc } from "./codex-rpc.ts";
import { deleteWake, enqueueWake, queuedWakes, threadState, type QueueRpc } from "./codex-queue.ts";
import { type ProcessingInbox } from "./inbox.ts";
import type { BridgeLog } from "./journal.ts";

export type DeliverDeps = {
  readonly inbox: ProcessingInbox;
  readonly log: BridgeLog;
  readonly codexHome?: string;
  readonly connect?: () => Promise<QueueRpc>;
  readonly isLive?: (session: SessionRequest) => Promise<boolean>;
  readonly retryMs?: number;
  readonly reconcileMs?: number;
};

/** Herdr owns lifetime only. No screen reads, idle parsing, typing, or transcript scans. */
async function livePane(session: SessionRequest): Promise<boolean> {
  const process = Bun.spawn(["herdr", "agent", "get", session.pane], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => process.kill(), 5_000);
  try {
    const [stdout, , code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) return false;
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || !("result" in parsed)) return false;
    const result = parsed.result;
    if (typeof result !== "object" || result === null || !("agent" in result)) return false;
    const agent = result.agent;
    return typeof agent === "object" && agent !== null && "agent" in agent && agent.agent === "codex";
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class Deliverer {
  private rpc: QueueRpc | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private needsCleanup = true;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private reconcile: ReturnType<typeof setInterval> | null = null;
  private readonly connect: () => Promise<QueueRpc>;

  constructor(private readonly deps: DeliverDeps) {
    this.connect = deps.connect ?? (() => CodexRpc.connect({
      socketPath: join(deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control/app-server-control.sock"),
    }));
  }

  start(): void {
    // A bounded local-state check also recovers a lost notification or a TUI
    // reconnect. It never polls the model or resumes an unloaded thread.
    this.reconcile = setInterval(() => this.kick(), this.deps.reconcileMs ?? 30_000);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.reconcile) clearInterval(this.reconcile);
    this.rpc?.close();
    await this.running;
  }

  onJournaled(event: InboxEvent): Promise<void> { return this.deps.inbox.eligible(event) ? this.kick() : Promise.resolve(); }
  onSessionSet(): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.needsCleanup = true;
    return this.kick();
  }
  onHandled(): Promise<void> { return this.kick(); }
  onInboxDrained(): Promise<void> { this.needsCleanup = true; return this.kick(); }

  private kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    if (this.running || this.retry) return this.running ?? Promise.resolve();
    this.running = this.loop().finally(() => {
      this.running = null;
      if (this.dirty && !this.retry) this.kick();
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        await this.deliver();
      }
    } catch (error) {
      if (this.stopped) return;
      this.deps.log("BRIDGE_WAKE_RETRY", { reason: error instanceof Error ? error.message : String(error) });
      this.rpc?.close();
      this.rpc = null;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.kick();
      }, this.deps.retryMs ?? 5_000);
    }
  }

  private async connection(): Promise<QueueRpc> {
    if (this.rpc) return this.rpc;
    const rpc = await this.connect();
    if (this.stopped) { rpc.close(); return rpc; }
    this.rpc = rpc;
    rpc.onClose(() => {
      if (this.rpc === rpc) this.rpc = null;
      this.kick();
    });
    rpc.subscribe((method, params) => {
      if ((method === "turn/completed" || method === "thread/status/changed") &&
        params.threadId === this.deps.inbox.session()?.sessionId) this.kick();
    });
    return rpc;
  }

  private async deliver(): Promise<void> {
    const inbox = this.deps.inbox;
    const session = inbox.session();
    if (!session || (!this.needsCleanup && !inbox.active() && inbox.pending(1).length === 0)) return;
    if (!(await (this.deps.isLive ?? livePane)(session))) return;
    const rpc = await this.connection();
    const old = inbox.active();
    if (old && old.sessionId !== session.sessionId) {
      for (const entry of await queuedWakes(rpc, old.sessionId)) await deleteWake(rpc, old.sessionId, entry.id);
      inbox.retire(old.wakeId);
    }
    const expectedWakeId = inbox.active()?.wakeId;
    const state = await threadState(rpc, session.sessionId);
    if (state === "notLoaded" || state === "systemError" || this.stopped) return;
    const entries = await queuedWakes(rpc, session.sessionId);
    const current = inbox.active();
    if (current?.wakeId !== expectedWakeId || inbox.session()?.sessionId !== session.sessionId) {
      this.dirty = true;
      return;
    }
    // Remove retired/duplicate entries, never another producer's native input.
    const matching = entries.filter((entry) => entry.wakeId === current?.wakeId);
    const keep = current?.phase === "received" ? null : matching[0]?.id;
    const reconciled = this.needsCleanup;
    for (const entry of entries) if (entry.id !== keep) await deleteWake(rpc, session.sessionId, entry.id);
    this.needsCleanup = false;
    if (inbox.active()?.wakeId !== expectedWakeId || inbox.session()?.sessionId !== session.sessionId) {
      this.dirty = true;
      return;
    }
    if (keep && current) {
      inbox.queued(current.wakeId, keep);
      if (reconciled) this.deps.log("BRIDGE_WAKE_RECONCILED", { wakeId: current.wakeId, queuedSubmissionId: keep });
      return;
    }
    if (current) {
      // Codex removes a queue row after starting its turn. The status observed
      // before queue/list may still describe the idle gap between turns.
      if (await threadState(rpc, session.sessionId) !== "idle" || this.stopped) return;
      if (inbox.active()?.wakeId !== expectedWakeId || inbox.session()?.sessionId !== session.sessionId) {
        this.dirty = true;
        return;
      }
    }
    if (inbox.pending(1).length === 0) {
      if (current) inbox.retire(current.wakeId);
      return;
    }
    // A missing native entry while the thread is active may already be starting
    // its turn. Reconcile only once idle; an ambiguous add is never blindly replayed.
    const wake = current ?? inbox.prepare(session.sessionId);
    if (!wake || this.stopped || inbox.session()?.sessionId !== session.sessionId) return;
    if (current) inbox.retry(current.wakeId);
    const id = await enqueueWake(rpc, wake);
    inbox.queued(wake.wakeId, id);
    this.deps.log("BRIDGE_WAKE_QUEUED", { wakeId: wake.wakeId, sessionId: wake.sessionId, queuedSubmissionId: id });
  }
}
