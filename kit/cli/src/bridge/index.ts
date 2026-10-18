// `hent bridge` (ADR-0002): the always-on, token-owning Discord bridge. Wires the token,
// gateway, journal and local API together. It never calls the Hent-ai service and never logs
// message content or the token.
//
// Backfill: after every IDENTIFY (READY) each configured guild channel is paginated over REST
// from its last journaled message id, while live events are buffered until it completes. A
// RESUME replays missed events itself. DM channels cannot be backfilled (no channel list to
// page through), so DMs missed while disconnected without a successful RESUME are lost.

import { join } from "node:path";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hentHome } from "../config.ts";
import { Discord, type DiscordMessage, discordApiBase } from "../messenger/discord.ts";
import type { Http } from "../messenger/http.ts";
import { type Clock, realClock } from "../run.ts";
import { BRIDGE_DEFAULT_PORT, type GatewayState, type InboxAttachment, type ParseResult } from "./contract.ts";
import { Gateway, type GatewayOptions } from "./gateway.ts";
import {
  type BridgeLog,
  bridgePaths,
  compareIds,
  ConsumerStore,
  ensurePrivateDir,
  HandledLedger,
  Journal,
  type NewInboxEvent,
  SentLedger,
} from "./journal.ts";
import { Deliverer, type DeliverDeps } from "./deliver.ts";
import { ProcessingInbox } from "./inbox.ts";
import { type BridgeHooks, startBridgeServer } from "./server.ts";
import { type KeychainReader, readDiscordToken, ensureBridgeSecret } from "./token.ts";

export type { BridgeHooks } from "./server.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type BridgeChannel = { readonly channelId: string; readonly guildId: string | null };
export type ChannelConfig = { readonly channels: readonly BridgeChannel[]; readonly dms: boolean };

const EMPTY_CONFIG: ChannelConfig = { channels: [], dms: false };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BACKFILL_PAGE = 100;

/** Parses `~/.hent/channels.json`: every listed channel is journaled and pushed to the session. */
export const parseChannelConfig = (input: unknown): ParseResult<ChannelConfig> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "channels.json must be an object" };
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.channels)) return { ok: false, error: "channels must be an array" };
  if (obj.dms !== undefined && typeof obj.dms !== "boolean") return { ok: false, error: "dms must be a boolean" };
  const channels: BridgeChannel[] = [];
  for (const raw of obj.channels) {
    const c = raw as Record<string, unknown> | null;
    if (typeof c?.channelId !== "string" || !ID.test(c.channelId)) return { ok: false, error: "channelId must match [A-Za-z0-9_-]{1,64}" };
    const guildId = c.guildId ?? null;
    if (guildId !== null && (typeof guildId !== "string" || !ID.test(guildId))) return { ok: false, error: `guildId of ${c.channelId} is invalid` };
    if (c.mode !== undefined) return { ok: false, error: `${c.channelId} has a "mode"; channel modes are gone, the session decides` };
    channels.push({ channelId: c.channelId, guildId });
  }
  return { ok: true, value: { channels, dms: obj.dms === true } };
};

/** Polls channels.json for changes; an invalid file keeps the previous config. */
class ChannelConfigWatcher {
  private config: ChannelConfig = EMPTY_CONFIG;
  private stamp = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly path: string,
    private readonly log: BridgeLog,
    private readonly onChange: (config: ChannelConfig) => void,
  ) {}

  get current(): ChannelConfig {
    return this.config;
  }

  start(pollMs: number): void {
    this.reload();
    this.timer = setInterval(() => this.reload(), pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  reload(): void {
    const exists = existsSync(this.path);
    const stamp = exists ? `${statSync(this.path).mtimeMs}:${statSync(this.path).size}` : "missing";
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    if (!exists) {
      this.config = EMPTY_CONFIG;
      this.log("BRIDGE_CONFIG_MISSING");
      this.onChange(this.config);
      return;
    }
    let parsed: ParseResult<ChannelConfig>;
    try {
      parsed = parseChannelConfig(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      parsed = { ok: false, error: "not valid JSON" };
    }
    if (!parsed.ok) {
      this.log("BRIDGE_CONFIG_INVALID", { reason: parsed.error });
      return;
    }
    this.config = parsed.value;
    this.log("BRIDGE_CONFIG_LOADED", { channels: parsed.value.channels.length, dms: parsed.value.dms });
    this.onChange(this.config);
  }
}

type GatewayMessage = Partial<DiscordMessage> & {
  readonly id?: string;
  readonly channel_id?: string;
  readonly edited_timestamp?: string | null;
  readonly referenced_message?: { readonly id?: string } | null;
  readonly author?: DiscordMessage["author"] & { readonly global_name?: string | null };
};

const bridgeHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(15_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

const formatLog =
  (sink: (line: string) => void, clock: Clock): BridgeLog =>
  (event, fields = {}) => {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${v === null ? "null" : String(v)}`);
    sink([new Date(clock.now()).toISOString(), event, ...parts].join(" "));
  };

export type StartBridgeOptions = {
  readonly env?: Env;
  /** Overrides HENT_BRIDGE_PORT; 0 picks a free port (tests). */
  readonly port?: number;
  readonly hooks?: BridgeHooks;
  readonly logSink?: (line: string) => void;
  readonly clock?: Clock;
  readonly http?: Http;
  readonly tokenRetryMs?: number;
  readonly configPollMs?: number;
  readonly gateway?: Pick<GatewayOptions, "reconnectDelayMs" | "invalidSessionDelayMs" | "random">;
  readonly readKeychain?: KeychainReader;
  readonly sendRetryDelayMs?: number;
  /** Gap between typing re-sends while a `hent typing --for` hold runs (tests shorten it). */
  readonly typingIntervalMs?: number;
  readonly deliver?: Pick<DeliverDeps, "connect" | "isLive" | "retryMs" | "reconcileMs"> & { readonly disabled?: boolean };
};

export type BridgeHandle = {
  readonly port: number;
  readonly home: string;
  readonly secret: string;
  readonly journal: Journal;
  readonly inbox: ProcessingInbox;
  /** Emits `log` (line), `state` (GatewayState), `journaled` (InboxEvent), `heartbeat_ack`, `synced`, `token`. */
  readonly events: EventEmitter;
  gatewayState(): GatewayState;
  gateway(): Gateway | null;
  /** Channels whose typing indicator is currently held by `hent typing --for`. */
  typingHolds(): number;
  stop(): Promise<void>;
};

export const startBridge = async (opts: StartBridgeOptions = {}): Promise<BridgeHandle> => {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? realClock;
  const events = new EventEmitter();
  const sink = opts.logSink ?? ((line: string) => console.error(line));
  const log = formatLog((line) => {
    sink(line);
    events.emit("log", line);
  }, clock);
  const hooks = opts.hooks ?? {};

  const home = hentHome(env);
  const paths = bridgePaths(home);
  ensurePrivateDir(home);
  ensurePrivateDir(paths.state);
  ensurePrivateDir(paths.consumers);
  const secret = ensureBridgeSecret(paths);
  const journal = Journal.open(paths, clock.now(), log);
  const sent = SentLedger.open(paths.sent, clock.now());
  const handled = HandledLedger.open(paths.handled, clock.now());
  const consumers = new ConsumerStore(paths.consumers, clock.now);

  let stopped = false;
  let gatewayState: GatewayState = "reconnecting";
  let botUserId: string | null = null;
  let discord: Discord | null = null;
  let gateway: Gateway | null = null;
  let tokenTimer: ReturnType<typeof setTimeout> | null = null;
  let syncing = 0;
  let buffered: NewInboxEvent[] = [];
  let syncChain: Promise<void> = Promise.resolve();

  let deliverer: Deliverer | null = null;
  journal.onAppend((event) => {
    events.emit("journaled", event);
    try {
      deliverer?.onJournaled(event);
      hooks.onJournaled?.(event);
    } catch (error) {
      log("BRIDGE_HOOK_FAILED", { hook: "onJournaled", name: error instanceof Error ? error.name : "error" });
    }
  });

  const config = new ChannelConfigWatcher(paths.channels, log, () => {
    if (gatewayState === "connected") queueSync(false);
  });

  const allowed = (channelId: string, guildId: string | null): boolean => {
    const current = config.current;
    if (current.channels.some((c) => c.channelId === channelId)) return true;
    return guildId === null && current.dms;
  };

  const toEvent = (kind: NewInboxEvent["kind"], m: GatewayMessage, createdAt: string): NewInboxEvent | null => {
    if (!m.id || !m.channel_id || !m.author) return null;
    const guildId = m.guild_id ?? null;
    if (!allowed(m.channel_id, guildId)) return null;
    const attachments: InboxAttachment[] = (m.attachments ?? []).map((a) => ({ url: a.url, contentType: a.content_type ?? null, name: a.filename }));
    return {
      kind,
      channelId: m.channel_id,
      guildId,
      messageId: m.id,
      authorId: m.author.id,
      authorIsBot: m.author.bot === true,
      authorIsSelf: botUserId !== null && m.author.id === botUserId,
      authorName: m.author.global_name ?? m.author.username,
      content: m.content ?? "",
      referencedMessageId: m.message_reference?.message_id ?? m.referenced_message?.id ?? null,
      attachments,
      createdAt,
    };
  };

  const record = (event: NewInboxEvent | null): void => {
    if (!event) return;
    if (syncing > 0) buffered.push(event);
    else journal.append(event);
  };

  const onDispatch = (type: string, data: unknown): void => {
    const m = data as GatewayMessage;
    switch (type) {
      case "READY":
        botUserId = (data as { user?: { id?: string } }).user?.id ?? null;
        queueSync(true);
        return;
      case "MESSAGE_CREATE":
        record(toEvent("message_create", m, m.timestamp ?? new Date(clock.now()).toISOString()));
        return;
      case "MESSAGE_UPDATE": {
        if (typeof m.content !== "string" || !m.id) return;
        const original = journal.findCreate(m.id);
        const author = m.author ?? (original ? { id: original.authorId, username: original.authorName, bot: original.authorIsBot } : undefined);
        record(toEvent("message_update", { ...m, author, guild_id: m.guild_id ?? original?.guildId ?? undefined }, m.edited_timestamp ?? new Date(clock.now()).toISOString()));
        return;
      }
      case "MESSAGE_DELETE": {
        const original = m.id ? journal.findCreate(m.id) : undefined;
        if (!original || !allowed(original.channelId, original.guildId)) return;
        record({ ...original, kind: "message_delete", content: "", attachments: [], createdAt: new Date(clock.now()).toISOString() });
        return;
      }
    }
  };

  const syncChannel = async (client: Discord, channelId: string, backfill: boolean): Promise<void> => {
    try {
      const cursor = journal.channelCursor(channelId);
      if (cursor === undefined) {
        const newest = await client.listMessages(channelId, { limit: 1 });
        if (journal.seedChannel(channelId, newest[0]?.id ?? "0")) log("BRIDGE_SEED", { channelId });
        return;
      }
      if (!backfill) return;
      let after = cursor;
      let count = 0;
      for (;;) {
        const page = (await client.listMessages(channelId, { after, limit: BACKFILL_PAGE })).slice().sort((a, b) => compareIds(a.id, b.id));
        for (const message of page) {
          const event = toEvent("message_create", message, message.timestamp);
          if (event && journal.append(event)) count++;
        }
        const last = page[page.length - 1];
        if (page.length < BACKFILL_PAGE || !last) break;
        after = last.id;
      }
      log("BRIDGE_BACKFILL", { channelId, journaled: count });
    } catch (error) {
      log("BRIDGE_BACKFILL_FAILED", { channelId, name: error instanceof Error ? error.name : "error" });
    }
  };

  const guildOf = new Map<string, string | null>();
  const isGuildChannel = async (client: Discord, channelId: string, configured: string | null): Promise<boolean> => {
    if (configured !== null) return true;
    if (!guildOf.has(channelId)) {
      try {
        guildOf.set(channelId, await client.channelGuild(channelId));
      } catch (error) {
        log("BRIDGE_CHANNEL_LOOKUP_FAILED", { channelId, name: error instanceof Error ? error.name : "error" });
        return false;
      }
    }
    return guildOf.get(channelId) !== null;
  };

  /** Seeds unseen channels; with `backfill` (after READY) also pages missed messages, buffering live events. */
  const queueSync = (backfill: boolean): void => {
    const client = discord;
    if (!client) return;
    syncing++;
    syncChain = syncChain.then(async () => {
      try {
        for (const channel of config.current.channels) {
          if (stopped) return;
          if (await isGuildChannel(client, channel.channelId, channel.guildId)) await syncChannel(client, channel.channelId, backfill);
        }
      } finally {
        syncing--;
        if (syncing === 0) {
          const pending = buffered;
          buffered = [];
          for (const event of pending) journal.append(event);
          events.emit("synced");
        }
      }
    });
  };

  const setGatewayState = (state: GatewayState): void => {
    gatewayState = state;
    events.emit("state", state);
  };

  const apiBase = discordApiBase(env);
  const connect = (token: string): void => {
    discord = new Discord(opts.http ?? bridgeHttp, clock, token, apiBase);
    const client = discord;
    const gatewayOverride = env.HENT_DISCORD_GATEWAY;
    gateway = new Gateway({
      token,
      resolveUrl: gatewayOverride ? async () => gatewayOverride : () => client.gatewayUrl(),
      log,
      onDispatch,
      onState: setGatewayState,
      onHeartbeatAck: () => events.emit("heartbeat_ack"),
      ...opts.gateway,
    });
    gateway.start();
  };

  const tokenRetryMs = opts.tokenRetryMs ?? 60_000;
  const lookForToken = async (): Promise<void> => {
    tokenTimer = null;
    if (stopped) return;
    const found = await readDiscordToken(paths, env, opts.readKeychain);
    if (stopped) return;
    if (found.token === undefined) {
      for (const problem of found.problems) log("BRIDGE_TOKEN_REFUSED", { reason: problem });
      log("BRIDGE_NO_TOKEN", { retryMs: tokenRetryMs });
      tokenTimer = setTimeout(() => void lookForToken(), tokenRetryMs);
      return;
    }
    log("BRIDGE_TOKEN_LOADED", { source: found.source });
    events.emit("token", found.source);
    connect(found.token);
  };

  const port = opts.port ?? (env.HENT_BRIDGE_PORT ? Number(env.HENT_BRIDGE_PORT) : BRIDGE_DEFAULT_PORT);
  const inbox = new ProcessingInbox({
    journal, handled, sessionPath: paths.session, wakePath: join(paths.state, "native-wake.json"), isBridged: allowed, log,
  });
  const server = startBridgeServer({
    port,
    secret,
    journal,
    consumers,
    sent,
    handled,
    inbox,
    sessionPath: paths.session,
    ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}),
    status: () => ({ gateway: gatewayState, botUserId }),
    discord: () => discord,
    clock,
    log,
    hooks: {
      ...hooks,
      onSessionSet: (session) => {
        deliverer?.onSessionSet();
        hooks.onSessionSet?.(session);
      },
      onHandled: (messageId) => {
        deliverer?.onHandled();
        hooks.onHandled?.(messageId);
      },
      onInboxDrained: () => {
        deliverer?.onInboxDrained();
        hooks.onInboxDrained?.();
      },
    },
    ...(opts.sendRetryDelayMs !== undefined ? { sendRetryDelayMs: opts.sendRetryDelayMs } : {}),
    ...(opts.typingIntervalMs !== undefined ? { typingIntervalMs: opts.typingIntervalMs } : {}),
  });
  const boundPort = server.port ?? port;
  log("BRIDGE_LISTENING", { host: "127.0.0.1", port: boundPort });
  config.start(opts.configPollMs ?? 2_000);
  if (!opts.deliver?.disabled) {
    deliverer = new Deliverer({
      inbox,
      log,
      ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}),
      ...(opts.deliver?.connect ? { connect: opts.deliver.connect } : {}),
      ...(opts.deliver?.isLive ? { isLive: opts.deliver.isLive } : {}),
      ...(opts.deliver?.retryMs !== undefined ? { retryMs: opts.deliver.retryMs } : {}),
      ...(opts.deliver?.reconcileMs !== undefined ? { reconcileMs: opts.deliver.reconcileMs } : {}),
    });
    deliverer.start();
  }
  void lookForToken();

  return {
    port: boundPort,
    home,
    secret,
    journal,
    inbox,
    events,
    gatewayState: () => gatewayState,
    gateway: () => gateway,
    typingHolds: () => server.typingHolds(),
    stop: async () => {
      stopped = true;
      if (tokenTimer) clearTimeout(tokenTimer);
      config.stop();
      await deliverer?.stop();
      gateway?.stop();
      await server.stop(true);
      await syncChain;
      log("BRIDGE_STOPPED");
    },
  };
};

/** Entry point for `hent bridge`: runs until SIGINT/SIGTERM. */
export const runBridgeCli = async (args: readonly string[]): Promise<number> => {
  if (args.length > 0) {
    console.error(`hent bridge: unexpected arguments: ${args.join(" ")}\nusage: hent bridge`);
    return 2;
  }
  const bridge = await startBridge();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await bridge.stop();
  return 0;
};
