// Session-facing `hent` subcommands: send / media / typing / skip / session / inbox / history /
// channels / memory. They talk to the local bridge (bearer from bridge.secret) and, for media
// only, to the Hent-ai service: everything on the reply path runs under one 2 s deadline, and only
// the style references of a drawing get the longer one. Service failures never block a send.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAffectArg } from "./affect.ts";
import { BRIDGE_DEFAULT_PORT, BRIDGE_ROUTES, MAX_MESSAGE_TEXT_LENGTH } from "./bridge/contract.ts";
import { bridgePaths, ensurePrivateDir, writePrivateFile } from "./bridge/journal.ts";
import { hentHome, loadConfig } from "./config.ts";
import { exportMemory } from "./memory.ts";
import { assetDeadline, fetchMedia, referenceDeadline, registerAsset, sendDeadline, type ServiceRouting, verdict } from "./service.ts";

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

/** `{ path, mode, distance, threshold, generate, references }`, one line, for the session to read. */
const mediaJson = (fields: {
  path: string | null;
  routing: ServiceRouting | null;
  references: readonly string[];
  reason?: string;
}): string =>
  JSON.stringify({
    path: fields.path,
    mode: fields.routing?.mode ?? null,
    distance: fields.routing?.distance ?? null,
    threshold: fields.routing?.threshold ?? null,
    generate: fields.routing?.generate ?? false,
    references: fields.references,
    ...(fields.reason ? { reason: fields.reason } : {}),
  });

const saveMedia = (dir: string, name: string, bytes: Uint8Array): string => {
  const out = join(dir, `${Date.now()}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`);
  writeFileSync(out, bytes, { mode: 0o600 });
  return out;
};

/** The reply budget covers the verdict and the chosen image; only a drawing's references may take longer. */
export type MediaDeadlines = { readonly reply: () => AbortSignal; readonly references: () => AbortSignal };
export const DEFAULT_MEDIA_DEADLINES: MediaDeadlines = { reply: sendDeadline, references: referenceDeadline };

export const cmdMedia = async (args: readonly string[], env: Env = process.env, deadlines: MediaDeadlines = DEFAULT_MEDIA_DEADLINES): Promise<number> => {
  const flags = parseFlags(args, ["pre-reply", "json"]);
  const channelId = flags.values.get("channel");
  const text = flags.values.get("text") ?? "";
  const asJson = flags.bools.has("json");
  if (!channelId) {
    console.error("usage: hent media --channel CH --text T [--affect V|C] [--pre-reply] [--json]");
    return 2;
  }
  const config = loadConfig(env);
  let url: string | null = null;
  let filename = "media.png";
  let routing: ServiceRouting | null = null;
  let reason = "no_media";
  const signal = deadlines.reply();
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
    // The session reads `--json`, so a malformed affect is its bug and is reported; the plain
    // output stays fail-open and answers NO_MEDIA as it always has.
    if (!affect) reason = "no_affect";
    else if (!affect.ok) {
      if (asJson) {
        console.error(`hent media: --affect: ${affect.error}`);
        return 2;
      }
      reason = "bad_affect";
    } else {
      const picked = await verdict(config, channelId, text, affect.affect, signal);
      if (!picked.ok) reason = picked.reason;
      else {
        routing = picked.routing;
        if (picked.media) {
          url = picked.media.url;
          filename = picked.media.filename;
        }
      }
    }
  }
  if (!url) {
    console.log(asJson ? mediaJson({ path: null, routing, references: [], reason }) : "NO_MEDIA");
    return 0;
  }
  const fetched = await fetchMedia(config, url, signal);
  if (!fetched.ok) {
    console.log(asJson ? mediaJson({ path: null, routing, references: [], reason: fetched.reason }) : `NO_MEDIA ${fetched.reason}`);
    return 0;
  }
  const dir = join(hentHome(env), "state", "media");
  ensurePrivateDir(dir);
  const out = saveMedia(dir, filename, fetched.bytes);
  if (!asJson) {
    console.log(out);
    return 0;
  }
  // Style references serve the drawing only, so a reply that sends an existing image never pays for
  // them. On the generate path they are downloaded again every call: the set changes between replies.
  const references: string[] = [];
  if (routing?.generate === true) {
    const referenceSignal = deadlines.references();
    const nearest = routing.nearest.slice(0, 3);
    for (let i = 0; i < nearest.length; i += 1) {
      const reference = nearest[i]!;
      const got = await fetchMedia(config, reference.url, referenceSignal);
      if (got.ok) references.push(saveMedia(dir, `ref${i}-${reference.filename}`, got.bytes));
    }
  }
  console.log(mediaJson({ path: out, routing, references }));
  return 0;
};

export const cmdAsset = async (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args);
  const channelId = flags.values.get("channel");
  const file = flags.values.get("file");
  const emotion = flags.values.get("emotion");
  const visualAffectArg = flags.values.get("visual-affect");
  const prompt = flags.values.get("prompt");
  if (flags.positional[0] !== "add" || !channelId || !file || !emotion || !visualAffectArg) {
    console.error("usage: hent asset add --channel CH --file PATH --emotion E --visual-affect JSON|@FILE [--prompt P]");
    return 2;
  }
  let visualAffect: unknown;
  try {
    visualAffect = JSON.parse(visualAffectArg.startsWith("@") ? readFileSync(visualAffectArg.slice(1), "utf8") : visualAffectArg);
  } catch (error) {
    console.error(`hent asset add: --visual-affect: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (typeof visualAffect !== "object" || visualAffect === null || Array.isArray(visualAffect)) {
    console.error("hent asset add: --visual-affect must be a JSON object");
    return 2;
  }
  let upload: NonNullable<MediaPick>;
  try {
    upload = readFileUpload(file)!;
  } catch (error) {
    console.error(`hent asset add: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const registered = await registerAsset(
    loadConfig(env),
    {
      channelId,
      emotion,
      contentType: upload.contentType,
      dataBase64: Buffer.from(upload.bytes).toString("base64"),
      visualAffect,
      ...(prompt !== undefined ? { prompt } : {}),
    },
    assetDeadline(),
  );
  if (!registered.ok) {
    console.error(`hent asset add: ${registered.reason}`);
    return 1;
  }
  console.log(`ASSET ${registered.id}`);
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

/** `--for SECONDS` hands the hold to the bridge and returns at once; the bridge keeps typing. */
export const cmdTyping = (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args);
  const channelId = flags.values.get("to");
  const forArg = flags.values.get("for");
  if (!channelId) {
    console.error("usage: hent typing --to CHANNEL [--for SECONDS]");
    return Promise.resolve(2);
  }
  if (forArg !== undefined && !/^[1-9]\d{0,3}$/.test(forArg.trim())) {
    console.error(`hent typing: --for must be a whole number of seconds, got "${forArg}"`);
    return Promise.resolve(2);
  }
  const body = { channelId, ...(forArg !== undefined ? { forSeconds: Number(forArg.trim()) } : {}) };
  return simpleBridgeCall(env, (b) => b.json("POST", BRIDGE_ROUTES.typing, body).then(() => undefined));
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
  const flags = parseFlags(args, []);
  if (flags.positional[0] !== "set") {
    console.error("usage: hent session set --agent codex --session-id ID --cwd DIR [--pane HERDR_PANE_ID]");
    return Promise.resolve(2);
  }
  const agent = flags.values.get("agent");
  const sessionId = flags.values.get("session-id");
  const cwd = flags.values.get("cwd") ?? process.cwd();
  const pane = flags.values.get("pane") ?? env.HERDR_PANE_ID;
  if (agent !== "codex" || !sessionId) {
    console.error("hent session set: --agent codex and --session-id are required");
    return Promise.resolve(2);
  }
  if (!pane) {
    console.error("hent session set: run inside a herdr pane ($HERDR_PANE_ID) or pass --pane");
    return Promise.resolve(2);
  }
  const body = { agent, sessionId, cwd, pane };
  return simpleBridgeCall(env, async (b) => {
    await b.json("POST", BRIDGE_ROUTES.session, body);
    console.log(`SESSION_SET agent=${agent} pane=${pane}`);
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

type ChannelEntry = { channelId: string; guildId: string | null };
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

/** Every listed channel is pushed to the session; whether to answer is the session's call (hent-mode skill). */
export const cmdChannels = async (args: readonly string[], env: Env = process.env): Promise<number> => {
  const flags = parseFlags(args);
  const [action, channelId] = flags.positional;
  const file = readChannels(env);
  switch (action) {
    case undefined:
    case "list":
      for (const c of file.channels) console.log(`${c.channelId}${c.guildId ? ` guild=${c.guildId}` : ""}`);
      console.log(`dms=${file.dms}`);
      return 0;
    case "add": {
      if (!channelId) {
        console.error("usage: hent channels add CHANNEL [--guild ID]");
        return 2;
      }
      if (!file.channels.some((c) => c.channelId === channelId)) file.channels.push({ channelId, guildId: flags.values.get("guild") ?? null });
      writeChannels(env, file);
      console.log(`CHANNEL_ADDED ${channelId}`);
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
    default:
      console.error("usage: hent channels [list|add|remove|dms]");
      return 2;
  }
};

// The bridge runs `herdr` from this PATH: the user's ~/.local/bin (where the native installers put
// current CLIs) must win over older Homebrew copies.
export const LAUNCHD_TEMPLATE = (bun: string, cli: string, home: string, userHome = homedir()): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.hent.bridge</string>
  <key>ProgramArguments</key>
  <array><string>${bun}</string><string>${cli}</string><string>bridge</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>HENT_HOME</key><string>${home}</string><key>PATH</key><string>${userHome}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${dirOf(bun)}</string></dict>
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
