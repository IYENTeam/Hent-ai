// Fake Discord (REST + gateway WebSocket) for bridge tests and real-surface QA.
// Run standalone: `bun test/fake-discord.ts` (FAKE_DISCORD_PORT, default 18800). Control it
// over HTTP under /_fake/* (push, rest-only, seed, kill, reject-resume, down, log).

import { EventEmitter } from "node:events";
import type { Server, ServerWebSocket } from "bun";

export type FakeAuthor = { id: string; username: string; bot?: boolean };
export type FakeMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: FakeAuthor;
  content: string;
  timestamp: string;
  attachments: { id: string; url: string; filename: string; content_type?: string }[];
  nonce?: string;
  message_reference?: { message_id: string };
};
export type FakeRequest = { method: string; path: string; query: Record<string, string>; body: unknown };
export type GatewayFrame = { op: number; d: unknown; s?: number | null; t?: string | null };

export type FakeDiscordOptions = {
  port?: number;
  heartbeatIntervalMs?: number;
  botUser?: FakeAuthor;
  guildId?: string;
};

type SocketData = { conn: number; sessionId: string | null };
type Session = { id: string; seq: number; log: { s: number; t: string; d: unknown }[] };

export type FakeDiscord = {
  readonly port: number;
  readonly apiBase: string;
  readonly gatewayUrl: string;
  readonly botUser: FakeAuthor;
  readonly guildId: string;
  /** REST requests (control routes excluded), in arrival order. */
  readonly requests: FakeRequest[];
  /** Frames received from gateway clients, in arrival order. */
  readonly frames: GatewayFrame[];
  /** Emits `request` (FakeRequest), `frame` (GatewayFrame), `open` (conn), `close` ({conn, code}). */
  readonly events: EventEmitter;
  connections(): number;
  rejectResume: boolean;
  ackHeartbeats: boolean;
  messages(channelId: string): FakeMessage[];
  seed(channelId: string, count: number): FakeMessage[];
  addMessage(channelId: string, opts: { content: string; author?: FakeAuthor; viaGateway?: boolean }): FakeMessage;
  dispatch(type: string, data: unknown): void;
  closeSockets(code?: number, reason?: string): void;
  goDown(ms: number): void;
  stop(): Promise<void>;
};

const HUMAN: FakeAuthor = { id: "700000000000000001", username: "human" };

export const waitForEvent = <T>(emitter: EventEmitter, name: string, pred: (value: T) => boolean = () => true, timeoutMs = 5_000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(name, listener);
      reject(new Error(`timed out after ${timeoutMs} ms waiting for "${name}"`));
    }, timeoutMs);
    const listener = (value: T): void => {
      if (!pred(value)) return;
      clearTimeout(timer);
      emitter.off(name, listener);
      resolve(value);
    };
    emitter.on(name, listener);
  });

export const startFakeDiscord = (opts: FakeDiscordOptions = {}): FakeDiscord => {
  const botUser = opts.botUser ?? { id: "900000000000000001", username: "hent-bot", bot: true };
  const guildId = opts.guildId ?? "800000000000000001";
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 41_250;
  const events = new EventEmitter();
  const requests: FakeRequest[] = [];
  const frames: GatewayFrame[] = [];
  const store = new Map<string, FakeMessage[]>();
  const nonces = new Map<string, FakeMessage>();
  const sessions = new Map<string, Session>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let current: Session | null = null;
  let nextId = 1_000_000_000_000_000_000n;
  let nextConn = 0;
  let opened = 0;
  let downUntil = 0;

  const channel = (id: string): FakeMessage[] => {
    let list = store.get(id);
    if (!list) store.set(id, (list = []));
    return list;
  };

  const create = (channelId: string, content: string, author: FakeAuthor, extra: Partial<FakeMessage> = {}): FakeMessage => {
    const message: FakeMessage = { id: String(nextId++), channel_id: channelId, guild_id: guildId, author, content, timestamp: new Date().toISOString(), attachments: [], ...extra };
    channel(channelId).push(message);
    return message;
  };

  const sendFrame = (ws: ServerWebSocket<SocketData>, frame: GatewayFrame): void => {
    ws.send(JSON.stringify(frame));
  };

  const socketFor = (session: Session): ServerWebSocket<SocketData> | undefined => [...sockets].find((ws) => ws.data.sessionId === session.id);

  const dispatch = (type: string, data: unknown): void => {
    const session = current;
    if (!session) return;
    const s = ++session.seq;
    session.log.push({ s, t: type, d: data });
    const ws = socketFor(session);
    if (ws) sendFrame(ws, { op: 0, s, t: type, d: data });
  };

  const self = {} as FakeDiscord;

  const onFrame = (ws: ServerWebSocket<SocketData>, frame: GatewayFrame): void => {
    frames.push(frame);
    events.emit("frame", frame);
    if (frame.op === 1) {
      if (self.ackHeartbeats) sendFrame(ws, { op: 11, d: null });
      return;
    }
    if (frame.op === 2) {
      const session: Session = { id: `sess-${crypto.randomUUID().slice(0, 8)}`, seq: 0, log: [] };
      sessions.set(session.id, session);
      current = session;
      ws.data.sessionId = session.id;
      const s = ++session.seq;
      sendFrame(ws, { op: 0, s, t: "READY", d: { v: 10, user: botUser, session_id: session.id, resume_gateway_url: gatewayUrl, guilds: [] } });
      return;
    }
    if (frame.op === 6) {
      const d = frame.d as { session_id?: string; seq?: number | null };
      const session = d.session_id ? sessions.get(d.session_id) : undefined;
      if (self.rejectResume || !session) {
        sendFrame(ws, { op: 9, d: false });
        return;
      }
      ws.data.sessionId = session.id;
      current = session;
      for (const entry of session.log) if (entry.s > (d.seq ?? 0)) sendFrame(ws, { op: 0, s: entry.s, t: entry.t, d: entry.d });
      const s = ++session.seq;
      sendFrame(ws, { op: 0, s, t: "RESUMED", d: null });
    }
  };

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });

  const rest = async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname.slice("/api/v10".length);
    let body: unknown = null;
    let file: File | null = null;
    const type = req.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await req.formData();
      body = JSON.parse(String(form.get("payload_json") ?? "{}"));
      const f = form.get("files[0]");
      file = f instanceof File ? f : null;
    } else if (type.includes("json")) body = await req.json();
    const entry: FakeRequest = { method: req.method, path, query: Object.fromEntries(url.searchParams), body: file ? { ...(body as object), file: file.name } : body };
    requests.push(entry);
    events.emit("request", entry);

    if (!req.headers.get("authorization")?.startsWith("Bot ")) return json({ message: "401: Unauthorized" }, 401);
    if (req.method === "GET" && path === "/users/@me") return json(botUser);
    if (req.method === "GET" && path === "/gateway/bot") return json({ url: gatewayUrl, shards: 1 });
    const typing = path.match(/^\/channels\/([^/]+)\/typing$/);
    if (typing && req.method === "POST") return new Response(null, { status: 204 });
    const one = path.match(/^\/channels\/([^/]+)\/messages\/([^/]+)$/);
    if (one && req.method === "PATCH") {
      const message = channel(one[1]!).find((m) => m.id === one[2]);
      if (!message) return json({ message: "Unknown Message", code: 10008 }, 404);
      message.content = String((body as { content?: string }).content ?? message.content);
      return json(message);
    }
    const list = path.match(/^\/channels\/([^/]+)\/messages$/);
    if (list && req.method === "GET") {
      const all = channel(list[1]!)
        .slice()
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 50));
      const after = url.searchParams.get("after");
      const picked = after ? all.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit) : all.slice(-limit);
      return json(picked.reverse());
    }
    if (list && req.method === "POST") {
      const b = body as { content?: string; nonce?: string; enforce_nonce?: boolean; message_reference?: { message_id: string } };
      const key = b.nonce && b.enforce_nonce ? `${list[1]}:${b.nonce}` : null;
      const prior = key ? nonces.get(key) : undefined;
      if (prior) return json(prior);
      const attachments = file ? [{ id: String(nextId++), url: `http://127.0.0.1:${server.port}/attachments/${file.name}`, filename: file.name, content_type: file.type }] : [];
      const message = create(list[1]!, b.content ?? "", botUser, {
        attachments,
        ...(b.nonce ? { nonce: b.nonce } : {}),
        ...(b.message_reference ? { message_reference: { message_id: b.message_reference.message_id } } : {}),
      });
      if (key) nonces.set(key, message);
      dispatch("MESSAGE_CREATE", message);
      return json(message);
    }
    return json({ message: "404: Not Found" }, 404);
  };

  const control = async (req: Request, url: URL): Promise<Response> => {
    const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>;
    const channelId = String(body.channelId ?? "");
    switch (url.pathname) {
      case "/_fake/push":
        return json(self.addMessage(channelId, { content: String(body.content ?? ""), viaGateway: true }));
      case "/_fake/rest-only":
        return json(self.addMessage(channelId, { content: String(body.content ?? ""), viaGateway: false }));
      case "/_fake/seed":
        return json({ seeded: self.seed(channelId, Number(body.count ?? 0)).length });
      case "/_fake/kill":
        self.closeSockets(Number(body.code ?? 4000));
        return json({ ok: true });
      case "/_fake/reject-resume":
        self.rejectResume = body.on !== false;
        return json({ rejectResume: self.rejectResume });
      case "/_fake/down":
        self.goDown(Number(body.ms ?? 10_000));
        return json({ downUntil });
      case "/_fake/log":
        return json({ requests, frames: frames.map((f) => ({ op: f.op, ...(f.op === 2 ? { intents: (f.d as { intents?: number }).intents } : {}) })), connections: opened });
    }
    return json({ message: "unknown control route" }, 404);
  };

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/gateway") {
        if (Date.now() < downUntil) return new Response("gateway down", { status: 503 });
        if (srv.upgrade(req, { data: { conn: ++nextConn, sessionId: null } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/_fake/")) return control(req, url);
      if (url.pathname.startsWith("/api/v10/")) return rest(req, url);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open: (ws) => {
        sockets.add(ws);
        opened++;
        events.emit("open", ws.data.conn);
        sendFrame(ws, { op: 10, d: { heartbeat_interval: heartbeatIntervalMs } });
      },
      message: (ws, data) => onFrame(ws, JSON.parse(String(data)) as GatewayFrame),
      close: (ws, code) => {
        sockets.delete(ws);
        events.emit("close", { conn: ws.data.conn, code });
      },
    },
  });
  const port = server.port ?? 0;
  const gatewayUrl = `ws://127.0.0.1:${port}/gateway`;

  Object.assign(self, {
    port,
    apiBase: `http://127.0.0.1:${port}/api/v10`,
    gatewayUrl,
    botUser,
    guildId,
    requests,
    frames,
    events,
    rejectResume: false,
    ackHeartbeats: true,
    connections: () => opened,
    messages: (channelId: string) => channel(channelId),
    seed: (channelId: string, count: number) => Array.from({ length: count }, (_, i) => create(channelId, `old message ${i + 1}`, HUMAN)),
    addMessage: (channelId: string, o: { content: string; author?: FakeAuthor; viaGateway?: boolean }) => {
      const message = create(channelId, o.content, o.author ?? HUMAN);
      if (o.viaGateway !== false) dispatch("MESSAGE_CREATE", message);
      return message;
    },
    dispatch,
    closeSockets: (code = 4000, reason = "fake close") => {
      for (const ws of sockets) ws.close(code, reason);
    },
    goDown: (ms: number) => {
      downUntil = Date.now() + ms;
      for (const ws of sockets) ws.close(4000, "fake gateway down");
    },
    stop: async () => {
      for (const ws of sockets) ws.close(1001, "fake stopping");
      await server.stop(true);
    },
  } satisfies Omit<FakeDiscord, never>);
  return self;
};

if (import.meta.main) {
  const fake = startFakeDiscord({ port: Number(process.env.FAKE_DISCORD_PORT ?? 18800), heartbeatIntervalMs: Number(process.env.FAKE_DISCORD_HEARTBEAT_MS ?? 2_000) });
  fake.events.on("open", (conn: number) => console.log(`FAKE_GATEWAY_OPEN conn=${conn}`));
  fake.events.on("close", (c: { conn: number; code: number }) => console.log(`FAKE_GATEWAY_CLOSE conn=${c.conn} code=${c.code}`));
  fake.events.on("frame", (f: GatewayFrame) => {
    if (f.op !== 1) console.log(`FAKE_GATEWAY_FRAME op=${f.op}`);
  });
  console.log(`FAKE_DISCORD_READY port=${fake.port} api=${fake.apiBase} gateway=${fake.gatewayUrl}`);
}
