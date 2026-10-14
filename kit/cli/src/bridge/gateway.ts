// Discord gateway client over bun's WebSocket (ADR-0002): HELLO, jittered heartbeat with
// zombie detection, IDENTIFY/RESUME, invalid-session re-identify, fatal close codes.
// Identify/heartbeat shape follows Dori's `discordPresence` (sisyphuslabs/omo-dori-mode-experimental
// @ 40034ad, MIT); see https://discord.com/developers/docs/events/gateway.

import type { GatewayState } from "./contract.ts";
import type { BridgeLog } from "./journal.ts";

export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes after which the old session cannot be resumed. */
const SESSION_ENDING_CLOSE_CODES: ReadonlySet<number> = new Set([4007, 4009]);
/** Our own close code when dropping a socket we still want to resume (not 1000/1001). */
const RESUMABLE_CLOSE = 4000;

const Op = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalidSession: 9, hello: 10, heartbeatAck: 11 } as const;

type Frame = { op: number; d: unknown; s?: number | null; t?: string | null };

export type GatewayOptions = {
  readonly token: string;
  readonly resolveUrl: () => Promise<string>;
  readonly log: BridgeLog;
  readonly onDispatch: (type: string, data: unknown) => void;
  readonly onState?: (state: GatewayState) => void;
  readonly onHeartbeatAck?: () => void;
  readonly reconnectDelayMs?: (attempt: number) => number;
  readonly invalidSessionDelayMs?: () => number;
  readonly random?: () => number;
};

const defaultReconnectDelay = (attempt: number): number => Math.min(10_000, 1_000 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
const defaultInvalidSessionDelay = (): number => 1_000 + Math.random() * 4_000;

const withGatewayQuery = (base: string): string => {
  const url = new URL(base);
  url.searchParams.set("v", "10");
  url.searchParams.set("encoding", "json");
  return url.toString();
};

export class Gateway {
  private current: GatewayState = "reconnecting";
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identifyTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingAck = false;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: GatewayOptions) {}

  get state(): GatewayState {
    return this.current;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "bridge stopping");
  }

  /** True while a socket is open or a reconnect/identify is scheduled (false after a fatal close). */
  active(): boolean {
    return this.ws !== null || this.reconnectTimer !== null || this.identifyTimer !== null;
  }

  private setState(state: GatewayState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onState?.(state);
  }

  private clearTimers(): void {
    for (const t of [this.heartbeatTimer, this.reconnectTimer, this.identifyTimer]) if (t) clearTimeout(t);
    this.heartbeatTimer = this.reconnectTimer = this.identifyTimer = null;
  }

  private async connect(): Promise<void> {
    this.reconnectTimer = null;
    if (this.stopped) return;
    const resuming = this.sessionId !== null && this.resumeUrl !== null;
    let base: string;
    try {
      base = resuming && this.resumeUrl ? this.resumeUrl : await this.opts.resolveUrl();
    } catch (error) {
      this.opts.log("BRIDGE_GATEWAY_URL_FAILED", { reason: error instanceof Error ? error.name : "error" });
      this.scheduleReconnect(null);
      return;
    }
    if (this.stopped) return;
    this.opts.log("BRIDGE_GATEWAY_CONNECT", { resume: resuming });
    const ws = new WebSocket(withGatewayQuery(base));
    this.ws = ws;
    this.awaitingAck = false;
    ws.onmessage = (ev: MessageEvent) => this.onMessage(ws, ev.data);
    ws.onclose = (ev: CloseEvent) => this.onClose(ws, ev.code);
  }

  private send(ws: WebSocket, frame: Frame): void {
    if (ws === this.ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    if (ws !== this.ws) return;
    let frame: Frame;
    try {
      frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer)) as Frame;
    } catch {
      this.opts.log("BRIDGE_GATEWAY_BAD_FRAME");
      return;
    }
    if (typeof frame.s === "number") this.seq = frame.s;
    switch (frame.op) {
      case Op.hello: {
        const interval = (frame.d as { heartbeat_interval?: number } | null)?.heartbeat_interval ?? 41_250;
        this.startHeartbeat(ws, interval);
        this.identifyOrResume(ws);
        return;
      }
      case Op.heartbeatAck:
        this.awaitingAck = false;
        this.opts.onHeartbeatAck?.();
        return;
      case Op.heartbeat:
        this.send(ws, { op: Op.heartbeat, d: this.seq });
        return;
      case Op.reconnect:
        this.opts.log("BRIDGE_RECONNECT_REQUESTED");
        this.dropSocket();
        return;
      case Op.invalidSession: {
        const resumable = frame.d === true;
        this.opts.log("BRIDGE_INVALID_SESSION", { resumable });
        if (!resumable) this.clearSession();
        const delay = (this.opts.invalidSessionDelayMs ?? defaultInvalidSessionDelay)();
        this.identifyTimer = setTimeout(() => {
          this.identifyTimer = null;
          this.identifyOrResume(ws);
        }, delay);
        return;
      }
      case Op.dispatch:
        this.onDispatch(frame.t ?? "", frame.d);
        return;
    }
  }

  private onDispatch(type: string, data: unknown): void {
    if (type === "READY") {
      const d = data as { session_id?: string; resume_gateway_url?: string };
      this.sessionId = d.session_id ?? null;
      this.resumeUrl = d.resume_gateway_url ?? null;
      this.attempt = 0;
      this.opts.log("BRIDGE_READY");
      this.setState("connected");
    } else if (type === "RESUMED") {
      this.attempt = 0;
      this.opts.log("BRIDGE_RESUMED");
      this.setState("connected");
    }
    this.opts.onDispatch(type, data);
  }

  private identifyOrResume(ws: WebSocket): void {
    if (this.sessionId !== null && this.resumeUrl !== null) {
      this.opts.log("BRIDGE_RESUME", { seq: this.seq });
      this.send(ws, { op: Op.resume, d: { token: this.opts.token, session_id: this.sessionId, seq: this.seq } });
      return;
    }
    this.opts.log("BRIDGE_IDENTIFY", { intents: GATEWAY_INTENTS });
    this.send(ws, {
      op: Op.identify,
      d: { token: this.opts.token, intents: GATEWAY_INTENTS, properties: { os: process.platform, browser: "hent-bridge", device: "hent-bridge" } },
    });
  }

  private startHeartbeat(ws: WebSocket, interval: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const beat = (): void => {
      if (ws !== this.ws) return;
      if (this.awaitingAck) {
        this.opts.log("BRIDGE_ZOMBIE_CONNECTION");
        this.dropSocket();
        return;
      }
      this.awaitingAck = true;
      this.send(ws, { op: Op.heartbeat, d: this.seq });
      this.heartbeatTimer = setTimeout(beat, interval);
    };
    const jitter = (this.opts.random ?? Math.random)();
    this.heartbeatTimer = setTimeout(beat, Math.floor(interval * jitter));
  }

  private clearSession(): void {
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
  }

  /** Closes the current socket with a resumable code and reconnects right away. */
  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearTimers();
    ws?.close(RESUMABLE_CLOSE, "reconnect");
    this.setState("reconnecting");
    this.scheduleReconnect(RESUMABLE_CLOSE, 0);
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    if (this.stopped) return;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.opts.log("BRIDGE_FATAL", { code });
      this.setState("fatal");
      return;
    }
    if (SESSION_ENDING_CLOSE_CODES.has(code)) this.clearSession();
    this.setState("reconnecting");
    this.scheduleReconnect(code);
  }

  private scheduleReconnect(code: number | null, delayOverride?: number): void {
    if (this.stopped) return;
    const delay = Math.round(delayOverride ?? (this.opts.reconnectDelayMs ?? defaultReconnectDelay)(this.attempt));
    this.attempt++;
    this.opts.log("BRIDGE_RECONNECT", { code, attempt: this.attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }
}
