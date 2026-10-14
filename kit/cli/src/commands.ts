// Session-facing `hent` subcommands: send / media / typing / skip / session / inbox / history /
// channels / memory. They talk to the local bridge (bearer from bridge.secret) and, for media
// only, to the Hent-ai service under one 2 s deadline. Service failures never block a send.

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAffectArg } from "./affect.ts";
import { BRIDGE_DEFAULT_PORT, BRIDGE_ROUTES, MAX_MESSAGE_TEXT_LENGTH } from "./bridge/contract.ts";
import { bridgePaths, ensurePrivateDir, writePrivateFile } from "./bridge/journal.ts";
import { hentHome, loadConfig } from "./config.ts";
import { exportMemory } from "./memory.ts";
import { fetchMedia, sendDeadline, verdict } from "./service.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type Flags = { readonly positional: string[]; readonly values: Map<string, string>; readonly bools: Set<string> };

export const parseFlags = (args: readonly string[], boolFlags: readonly string[] = []): Flags => {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq !== -1) values.set(name, arg.slice(eq + 1));
    else if (boolFlags.includes(name)) bools.add(name);
    else {
      const next = args[i + 1];
      if (next === undefined) throw new Error(`--${name} needs a value`);
      values.set(name, next);
      i += 1;
    }
  }
  return { positional, values, bools };
};

export class BridgeClient {
  constructor(
    private readonly base: string,
    private readonly secret: string,
  ) {}

  static fromEnv(env: Env = process.env): BridgeClient {
    const home = hentHome(env);
    const secretPath = bridgePaths(home).secret;
    if (!existsSync(secretPath)) throw new BridgeDownError(`bridge secret not found at ${secretPath}; is \`hent bridge\` running?`);
    const port = env.HENT_BRIDGE_PORT ? Number(env.HENT_BRIDGE_PORT) : BRIDGE_DEFAULT_PORT;
    return new BridgeClient(`http://127.0.0.1:${port}`, readFileSync(secretPath, "utf8").trim());
  }

  async request(method: "GET" | "POST", path: string, body?: string | FormData, contentType?: string): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.secret}`, ...(contentType ? { "content-type": contentType } : {}) },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw new BridgeDownError(error instanceof Error ? error.message : String(error));
    }
  }

  async json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : "application/json");
    const text = await res.text();
    if (!res.ok) throw new Error(`bridge ${path}: ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export class BridgeDownError extends Error {}

export const newNonce = (): string => randomBytes(12).toString("base64url").replace(/-/g, "_").slice(0, 16);

export const chunkText = (text: string, max = MAX_MESSAGE_TEXT_LENGTH): string[] => {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
};

type MediaPick = { readonly bytes: Uint8Array<ArrayBuffer>; readonly name: string; readonly contentType: string } | null;

const pickMedia = async (env: Env, channelId: string, text: string, affectArg: string | undefined): Promise<{ media: MediaPick; reason: string }> => {
  const config = loadConfig(env);
  if (!config.enabled) return { media: null, reason: "disabled" };
  if (!affectArg) return { media: null, reason: "no_affect" };
  const affect = parseAffectArg(affectArg);
  if (!affect.ok) return { media: null, reason: "bad_affect" };
  const signal = sendDeadline();
  const picked = await verdict(config, channelId, text, affect.affect, signal);
  if (!picked.ok) return { media: null, reason: picked.reason };
  if (!picked.media) return { media: null, reason: "no_media" };
  const fetched = await fetchMedia(config, picked.media.url, signal);
  if (!fetched.ok) return { media: null, reason: fetched.reason };
  const name = picked.media.sensitiveMedia ? `SPOILER_${picked.media.filename}` : picked.media.filename;
  return { media: { bytes: fetched.bytes, name, contentType: fetched.contentType }, reason: "ok" };
};

const sendChunk = async (
  bridge: BridgeClient,
  channelId: string,
  text: string,
  nonce: string,
  replyTo: string | undefined,
  file: MediaPick,
): Promise<string> => {
  const payload = { channelId, text, nonce, ...(replyTo ? { replyToMessageId: replyTo } : {}) };
  if (!file) return (await bridge.json<{ messageId: string }>("POST", BRIDGE_ROUTES.send, payload)).messageId;
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  form.set("file", new Blob([file.bytes], { type: file.contentType }), file.name);
  const res = await bridge.request("POST", BRIDGE_ROUTES.send, form);
  const text_ = await res.text();
  if (!res.ok) throw new Error(`bridge send: ${res.status} ${text_.slice(0, 200)}`);
  return (JSON.parse(text_) as { messageId: string }).messageId;
};

const readFileUpload = (path: string): MediaPick => {
  const bytes = new Uint8Array(readFileSync(path)) as Uint8Array<ArrayBuffer>;
  const name = path.split("/").pop() ?? "file";
  const ext = name.split(".").pop()?.toLowerCase();
  const contentType = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "application/octet-stream";
  return { bytes, name, contentType };
};

export const cmdSend = async (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args);
  const channelId = flags.values.get("to");
  const text = flags.values.get("text");
  if (!channelId || text === undefined) {
    console.error("usage: hent send --to CHANNEL --text TEXT [--affect V|C] [--file PATH] [--reply-to MSG] [--edit MSG] [--nonce N]");
    return 2;
  }
  let bridge: BridgeClient;
  try {
    bridge = BridgeClient.fromEnv(env);
  } catch (error) {
    console.error(`BRIDGE_DOWN ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }
  try {
    const editId = flags.values.get("edit");
    if (editId) {
      await bridge.json("POST", BRIDGE_ROUTES.edit, { channelId, messageId: editId, text });
      console.log(`EDITED ${editId}`);
      return 0;
    }
    const affectArg = flags.values.get("affect");
    if (affectArg) {
      const affect = parseAffectArg(affectArg);
      if (!affect.ok) {
        console.error(`hent send: --affect: ${affect.error}`);
        return 2;
      }
    }
    const filePath = flags.values.get("file");
    const picked = filePath ? { media: readFileUpload(filePath), reason: "file" } : await pickMedia(env, channelId, text, affectArg);
    const nonce = flags.values.get("nonce") ?? newNonce();
    const chunks = chunkText(text);
    const replyTo = flags.values.get("reply-to");
    let lastId = "";
    let mediaNote = picked.media ? "yes" : `no:${picked.reason}`;
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const chunkNonce = chunks.length === 1 ? nonce : `${nonce}-${i}`;
      const chunkReplyTo = isLast ? replyTo : undefined;
      const media = isLast ? picked.media : null;
      try {
        lastId = await sendChunk(bridge, channelId, chunks[i]!, chunkNonce, chunkReplyTo, media);
      } catch (error) {
        if (!media || error instanceof BridgeDownError || filePath) throw error;
        mediaNote = "no:media_rejected";
        lastId = await sendChunk(bridge, channelId, chunks[i]!, chunkNonce, chunkReplyTo, null);
      }
    }
    console.log(`SENT ${lastId} media=${mediaNote}`);
    return 0;
  } catch (error) {
    if (error instanceof BridgeDownError) {
      console.error(`BRIDGE_DOWN ${error.message}`);
      return 4;
    }
    console.error(`hent send: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

export const cmdMedia = async (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args, ["pre-reply"]);
  const channelId = flags.values.get("channel");
  const text = flags.values.get("text") ?? "";
  if (!channelId) {
    console.error("usage: hent media --channel CH --text T [--affect V|C] [--pre-reply]");
    return 2;
  }
  const config = loadConfig(env);
  let url: string | null = null;
  let filename = "media.png";
  const signal = sendDeadline();
  if (flags.bools.has("pre-reply")) {
    if (!config.url || !config.token) {
      console.log("NO_MEDIA not_configured");
      return 0;
    }
    try {
      const res = await fetch(`${config.url}/v1/pre-reply/media`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ context: { channelId, content: text }, userMessage: text }),
        signal,
      });
      const body = (await res.json()) as { media?: { url?: string; filename?: string } | null };
      if (res.ok && body.media?.url) {
        url = body.media.url;
        filename = body.media.filename ?? filename;
      }
    } catch {
      url = null;
    }
  } else {
    const affectArg = flags.values.get("affect");
    const affect = affectArg ? parseAffectArg(affectArg) : null;
    if (affect && affect.ok) {
      const picked = await verdict(config, channelId, text, affect.affect, signal);
      if (picked.ok && picked.media) {
        url = picked.media.url;
        filename = picked.media.filename;
      }
    }
  }
  if (!url) {
    console.log("NO_MEDIA");
    return 0;
  }
  const fetched = await fetchMedia(config, url, signal);
  if (!fetched.ok) {
    console.log(`NO_MEDIA ${fetched.reason}`);
    return 0;
  }
  const dir = join(hentHome(env), "state", "media");
  ensurePrivateDir(dir);
  const out = join(dir, `${Date.now()}-${filename.replace(/[^A-Za-z0-9._-]/g, "_")}`);
  writeFileSync(out, fetched.bytes, { mode: 0o600 });
  console.log(out);
  return 0;
};

const simpleBridgeCall = async (env: Env, op: (bridge: BridgeClient) => Promise<void>): Promise<number> => {
  try {
    await op(BridgeClient.fromEnv(env));
    return 0;
  } catch (error) {
    console.error(error instanceof BridgeDownError ? `BRIDGE_DOWN ${error.message}` : String(error instanceof Error ? error.message : error));
    return error instanceof BridgeDownError ? 4 : 1;
  }
};

export const cmdTyping = (args: readonly string[], env: Env = process.env): Promise<number> => {
  const channelId = parseFlags(args).values.get("to");
  if (!channelId) {
    console.error("usage: hent typing --to CHANNEL");
    return Promise.resolve(2);
  }
  return simpleBridgeCall(env, (b) => b.json("POST", BRIDGE_ROUTES.typing, { channelId }).then(() => undefined));
};

export const cmdSkip = (args: readonly string[], env: Env = process.env): Promise<number> => {
  const [messageId] = parseFlags(args).positional;
  if (!messageId) {
    console.error("usage: hent skip MESSAGE_ID");
    return Promise.resolve(2);
  }
  return simpleBridgeCall(env, async (b) => {
    await b.json("POST", BRIDGE_ROUTES.handled, { messageId, how: "skipped" });
    console.log(`SKIPPED ${messageId}`);
  });
};

export const cmdSession = (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args, ["headless"]);
  if (flags.positional[0] !== "set") {
    console.error("usage: hent session set --agent claude|codex --session-id ID --cwd DIR [--pane PANE | --headless]");
    return Promise.resolve(2);
  }
  const agent = flags.values.get("agent");
  const sessionId = flags.values.get("session-id");
  const cwd = flags.values.get("cwd") ?? process.cwd();
  const pane = flags.bools.has("headless") ? undefined : (flags.values.get("pane") ?? env.TMUX_PANE);
  if ((agent !== "claude" && agent !== "codex") || !sessionId) {
    console.error("hent session set: --agent claude|codex and --session-id are required");
    return Promise.resolve(2);
  }
  const body = { agent, sessionId, cwd, mode: pane ? "pane" : "headless", pane: pane ?? null };
  return simpleBridgeCall(env, async (b) => {
    await b.json("POST", BRIDGE_ROUTES.session, body);
    console.log(`SESSION_SET agent=${agent} mode=${body.mode}${pane ? ` pane=${pane}` : ""}`);
  });
};

export const cmdInbox = (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args, ["tail"]);
  const n = Number(flags.positional[0] ?? flags.values.get("tail") ?? 20);
  return simpleBridgeCall(env, async (b) => {
    const res = await b.json<{ events: unknown[] }>("GET", `${BRIDGE_ROUTES.inbox}?consumer=debug-tail&wait=0`);
    for (const event of res.events.slice(-n)) console.log(JSON.stringify(event));
  });
};

export const cmdHistory = (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args);
  const channelId = flags.values.get("channel");
  if (!channelId) {
    console.error("usage: hent history --channel CH [--limit N]");
    return Promise.resolve(2);
  }
  const limit = flags.values.get("limit") ?? "30";
  return simpleBridgeCall(env, async (b) => {
    const res = await b.json<{ events: unknown[] }>("GET", `${BRIDGE_ROUTES.history}?channelId=${encodeURIComponent(channelId)}&limit=${encodeURIComponent(limit)}`);
    for (const event of res.events) console.log(JSON.stringify(event));
  });
};

type ChannelEntry = { channelId: string; guildId: string | null; mode: "reply" | "ambient" | "observe"; tunables?: Record<string, unknown> };
type ChannelsFile = { channels: ChannelEntry[]; dms: boolean };

const channelsPath = (env: Env): string => bridgePaths(hentHome(env)).channels;

export const readChannels = (env: Env): ChannelsFile => {
  try {
    const parsed = JSON.parse(readFileSync(channelsPath(env), "utf8")) as Partial<ChannelsFile>;
    return { channels: Array.isArray(parsed.channels) ? parsed.channels : [], dms: parsed.dms === true };
  } catch {
    return { channels: [], dms: false };
  }
};

const writeChannels = (env: Env, file: ChannelsFile): void => writePrivateFile(channelsPath(env), `${JSON.stringify(file, null, 2)}\n`);

const MODES = new Set(["reply", "ambient", "observe"]);
const AMBIENT_TUNABLE_KEYS = ["ambientBudgetPerHour", "ambientConfidenceFloor", "ambientIdleDecayTauMs", "ambientPressureTauMs", "ambientPityEnabled", "ambientAddressAliases"];

type ServiceChannel = { channelId: string; enabled?: boolean | null; settings?: Record<string, unknown> | null };

export const readChannelSettings = (dbPath: string): ServiceChannel[] => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT channel_id, enabled, settings_json FROM channel_settings").all() as { channel_id: string; enabled: number | null; settings_json: string | null }[];
    return rows.map((row) => {
      let settings: Record<string, unknown> | null = null;
      try {
        settings = row.settings_json ? (JSON.parse(row.settings_json) as Record<string, unknown>) : null;
      } catch {
        settings = null;
      }
      return { channelId: row.channel_id, enabled: row.enabled === 1, settings };
    });
  } finally {
    db.close();
  }
};

export const importedChannels = (rows: readonly ServiceChannel[], current: ChannelsFile): ChannelsFile => {
  const byId = new Map(current.channels.map((c) => [c.channelId, c]));
  for (const row of rows) {
    if (row.enabled !== true || !/^\d{17,20}$/.test(row.channelId) || byId.has(row.channelId)) continue;
    const tunables = Object.fromEntries(Object.entries(row.settings ?? {}).filter(([k]) => AMBIENT_TUNABLE_KEYS.includes(k)));
    byId.set(row.channelId, { channelId: row.channelId, guildId: null, mode: "observe", ...(Object.keys(tunables).length ? { tunables } : {}) });
  }
  return { channels: [...byId.values()], dms: current.dms };
};

export const cmdChannels = async (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args);
  const [action, channelId, mode] = flags.positional;
  const file = readChannels(env);
  switch (action) {
    case undefined:
    case "list":
      for (const c of file.channels) console.log(`${c.channelId} ${c.mode}${c.guildId ? ` guild=${c.guildId}` : ""}`);
      console.log(`dms=${file.dms}`);
      return 0;
    case "add":
    case "set": {
      if (!channelId || !MODES.has(mode ?? "")) {
        console.error(`usage: hent channels ${action} CHANNEL reply|ambient|observe [--guild ID]`);
        return 2;
      }
      const existing = file.channels.find((c) => c.channelId === channelId);
      if (existing) existing.mode = mode as ChannelEntry["mode"];
      else if (action === "set") {
        console.error(`hent channels set: ${channelId} is not configured; use add`);
        return 2;
      } else file.channels.push({ channelId, guildId: flags.values.get("guild") ?? null, mode: mode as ChannelEntry["mode"] });
      writeChannels(env, file);
      console.log(`CHANNEL ${channelId} ${mode}`);
      return 0;
    }
    case "remove": {
      if (!channelId) {
        console.error("usage: hent channels remove CHANNEL");
        return 2;
      }
      writeChannels(env, { ...file, channels: file.channels.filter((c) => c.channelId !== channelId) });
      console.log(`CHANNEL_REMOVED ${channelId}`);
      return 0;
    }
    case "dms": {
      if (channelId !== "on" && channelId !== "off") {
        console.error("usage: hent channels dms on|off");
        return 2;
      }
      writeChannels(env, { ...file, dms: channelId === "on" });
      console.log(`DMS ${channelId}`);
      return 0;
    }
    case "import": {
      const fromDb = flags.values.get("from-db");
      let rows: ServiceChannel[] | null = null;
      if (!fromDb) {
        const config = loadConfig(env);
        const url = flags.values.get("from-service") ?? config.url;
        if (url && config.token) {
          const res = await fetch(`${url.replace(/\/+$/, "")}/v1/channels`, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
          if (res?.ok) rows = ((await res.json()) as { channels?: ServiceChannel[] }).channels ?? [];
          else if (res && res.status !== 404) {
            console.error(`hent channels import: service returned ${res.status}`);
            return 1;
          }
        }
      }
      if (rows === null) {
        const dbPath = fromDb ?? join(env.HOME ?? "", ".hent-ai", "data", "hent-ai-service.db");
        if (!existsSync(dbPath)) {
          console.error(`hent channels import: no /v1/channels on the service and no database at ${dbPath}; pass --from-db PATH`);
          return 2;
        }
        rows = readChannelSettings(dbPath);
        console.error(`hent channels import: read channel_settings read-only from ${dbPath}`);
      }
      const next = importedChannels(rows, file);
      writeChannels(env, next);
      console.log(`CHANNELS_IMPORTED total=${next.channels.length} (new channels start in observe mode)`);
      return 0;
    }
    default:
      console.error("usage: hent channels [list|add|set|remove|dms|import]");
      return 2;
  }
};

export const LAUNCHD_TEMPLATE = (bun: string, cli: string, home: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hent.bridge</string>
  <key>ProgramArguments</key>
  <array><string>${bun}</string><string>${cli}</string><string>bridge</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>HENT_HOME</key><string>${home}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${dirOf(bun)}</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${home}/bridge.log</string>
  <key>StandardOutPath</key><string>${home}/bridge.log</string>
</dict>
</plist>
`;

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

export const cmdBridgeInstall = (env: Env = process.env): number => {
  const home = hentHome(env);
  const cli = new URL("./cli.ts", import.meta.url).pathname;
  const target = join(env.HOME ?? "", "Library", "LaunchAgents", "ai.hent.bridge.plist");
  writePrivateFile(target, LAUNCHD_TEMPLATE(process.execPath, cli, home));
  console.log(`BRIDGE_PLIST ${target} (load with: launchctl bootstrap gui/$(id -u) ${target})`);
  return 0;
};

export const cmdMemory = (args: readonly string[], env: Env = process.env): number => {
  const flags = parseFlags(args);
  if (flags.positional[0] !== "export") {
    console.error("usage: hent memory export --db PATH [--out DIR]");
    return 2;
  }
  const dbPath = flags.values.get("db");
  if (!dbPath) {
    console.error("hent memory export: --db is required");
    return 2;
  }
  try {
    const result = exportMemory({ dbPath, outDir: flags.values.get("out") ?? join(hentHome(env), "memory") });
    console.log(`MEMORY_EXPORTED channels=${result.channels} people=${result.people}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
