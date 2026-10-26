// Each override owns a thread and a wake. The legacy session owns all other
// bridged channels, including DMs. A stopped override never falls back to it.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionRequest, type SessionRequest } from "./contract.ts";
import { CodexRpc } from "./codex-rpc.ts";
import { ProcessingInbox, readSession, StaleWakeError, type BridgedLookup, type WakeRequest } from "./inbox.ts";
import { writePrivateFile, type BridgeLog, type BridgePaths, type HandledLedger, type Journal } from "./journal.ts";

export class SessionConflictError extends Error {}

export class ChannelSessions {
  readonly defaultInbox: ProcessingInbox;
  private readonly channels = new Map<string, SessionRequest>();
  private readonly inboxes = new Map<string, ProcessingInbox>();
  private registration: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(private readonly deps: {
    readonly paths: BridgePaths;
    readonly journal: Journal;
    readonly handled: HandledLedger;
    readonly isBridged: BridgedLookup;
    readonly log: BridgeLog;
    readonly codexHome?: string;
    readonly now: () => number;
  }) {
    this.path = join(deps.paths.home, "channel-sessions.json");
    this.defaultInbox = this.createInbox();
    if (!existsSync(this.path)) return;
    const values: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(values)) throw new SessionConflictError("channel-sessions.json must be an array");
    for (const value of values) {
      const parsed = parseSessionRequest(value);
      if (!parsed.ok) throw new SessionConflictError(parsed.error);
      const session = parsed.value;
      if (!session.channelId || this.channels.has(session.channelId)) throw new SessionConflictError("duplicate or missing channelId");
      this.checkOwnership(session);
      this.channels.set(session.channelId, session);
      this.inboxes.set(session.channelId, this.createInbox(session.channelId));
    }
  }

  all(): readonly ProcessingInbox[] { return [this.defaultInbox, ...this.inboxes.values()]; }

  forWake(request: WakeRequest): ProcessingInbox {
    const inbox = this.all().find((item) => item.session()?.sessionId === request.sessionId);
    if (!inbox) throw new StaleWakeError("wake does not belong to a registered session");
    return inbox;
  }

  /** Serializes ownership checks, RPC setup and publication across registrations. */
  async register(request: SessionRequest): Promise<void> {
    const previous = this.registration;
    const gate = Promise.withResolvers<void>();
    this.registration = gate.promise;
    await previous;
    try {
      this.checkOwnership(request);
      const { configureCodex, ...session } = request;
      if (configureCodex || session.channelId !== undefined) {
        const rpc = await CodexRpc.connect({
          socketPath: join(this.deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control/app-server-control.sock"),
        });
        try {
          // Codex 0.164 ThreadSettingsUpdateParams: effort (not reasoningEffort).
          // Queue/add carries no settings; it runs with its thread's settings.
          await rpc.request("thread/settings/update", {
            threadId: session.sessionId,
            ...(session.channelId !== undefined ? { model: session.model, effort: session.effort } : {}),
            ...(configureCodex ? {
              sandboxPolicy: { type: "workspaceWrite", writableRoots: [this.deps.paths.home], networkAccess: true },
            } : {}),
          });
        } finally {
          rpc.close();
        }
      }
      // A drain may have begun while the settings RPC was in flight.
      this.checkOwnership(session);
      if (session.channelId === undefined) {
        writePrivateFile(this.deps.paths.session, `${JSON.stringify({ ...session, updatedAt: new Date(this.deps.now()).toISOString() }, null, 2)}\n`);
      } else {
        const next = new Map(this.channels);
        next.set(session.channelId, session);
        writePrivateFile(this.path, `${JSON.stringify([...next.values()], null, 2)}\n`);
        this.channels.set(session.channelId, session);
        if (!this.inboxes.has(session.channelId)) this.inboxes.set(session.channelId, this.createInbox(session.channelId));
      }
    } finally {
      gate.resolve();
    }
  }

  private checkOwnership(session: SessionRequest): void {
    const otherSessions = [readSession(this.deps.paths.session), ...this.channels.values()];
    for (const other of otherSessions) {
      if (other && other.channelId !== session.channelId &&
        (other.sessionId === session.sessionId || other.pane === session.pane)) {
        throw new SessionConflictError("each channel override must use a separate Codex thread and herdr pane");
      }
    }
    for (const inbox of this.all()) {
      if (inbox.session()?.channelId !== session.channelId && inbox.active()?.sessionId === session.sessionId) {
        throw new SessionConflictError("thread still owns another lane's wake");
      }
    }
    // Adding a partition must not duplicate work already fetched by the default
    // brain. Replacing a brain within its existing lane retains legacy recovery.
    if (session.channelId !== undefined && !this.channels.has(session.channelId) &&
      this.defaultInbox.active()?.phase === "received" &&
      this.defaultInbox.pending().some((event) => event.channelId === session.channelId)) {
      throw new SessionConflictError("drain the default session's received work before transferring its channel");
    }
  }

  private createInbox(channelId?: string): ProcessingInbox {
    return new ProcessingInbox({
      journal: this.deps.journal,
      handled: this.deps.handled,
      sessionPath: this.deps.paths.session,
      getSession: () => channelId === undefined ? readSession(this.deps.paths.session) : this.channels.get(channelId) ?? null,
      wakePath: join(this.deps.paths.state, channelId === undefined ? "native-wake.json" : `native-wake-channel-${channelId}.json`),
      isBridged: (id, guildId) => this.deps.isBridged(id, guildId) &&
        (channelId === undefined ? !this.channels.has(id) : id === channelId),
      log: this.deps.log,
    });
  }
}
