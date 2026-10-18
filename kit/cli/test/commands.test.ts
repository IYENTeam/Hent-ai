import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BridgeHandle, startBridge } from "../src/bridge/index.ts";
import { parseChannelConfig } from "../src/bridge/index.ts";
import { DEFAULT_MEDIA_DEADLINES, chunkText, cmdAsset, cmdChannels, cmdMedia, cmdSend, cmdSession, cmdSkip, cmdTyping, readChannels } from "../src/commands.ts";
import { sendDeadline } from "../src/service.ts";
import { type FakeDiscord, startFakeDiscord, waitForEvent } from "./fake-discord.ts";

const CH = "100000000000000001";
const AFFECT = `${Array(24).fill(40).join(",")}|90`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Service = {
  url: string;
  requests: string[];
  mode: "media" | "hang" | "down";
  /** Omitted entirely by an older service that has no fit signal. */
  routing?: unknown;
  assets: unknown[];
  assetStatus: number;
  /** Resolves once the service has a request in hand - the point where a hang starts. */
  firstRequest: Promise<string>;
};

const ROUTING = {
  mode: "affect-v2",
  distance: 0.42,
  threshold: 0.3,
  generate: true,
  nearest: [
    { url: "/static/sets/s/happy-1.png", filename: "happy-1.png", distance: 0.42 },
    { url: "/static/sets/s/happy-2.png", filename: "happy-2.png", distance: 0.5 },
    { url: "/static/sets/s/focused-1.png", filename: "focused-1.png", distance: 0.61 },
  ],
};

const startService = (): Service => {
  let announce: (request: string) => void = () => {};
  const firstRequest = new Promise<string>((resolve) => { announce = resolve; });
  const state: Service = { url: "", requests: [], mode: "media", assets: [], assetStatus: 201, firstRequest };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      state.requests.push(`${req.method} ${path}`);
      announce(`${req.method} ${path}`);
      // A hanging service never answers; the caller's deadline is what ends the wait.
      if (state.mode === "hang") await new Promise<never>(() => {});
      if (path === "/v1/final-response/verdict") {
        const media = { url: "/static/sets/s/happy-1.png", filename: "happy-1.png", contentType: "image/png", sensitiveMedia: false };
        return Response.json({ verdict: { media, ...(state.routing === undefined ? {} : { routing: state.routing }) } });
      }
      if (path === "/v1/assets") {
        state.assets.push(await req.json());
        if (state.assetStatus !== 201) return Response.json({ error: "native_asset_error", message: "Invalid image bytes or contentType" }, { status: state.assetStatus });
        return Response.json({ asset: { id: "native_0123456789ab", assetSetId: "s", emotion: "happy", filename: "0123456789ab.png" }, media: { url: "/static/native/s/happy/0123456789ab.png" } }, { status: 201 });
      }
      if (path.startsWith("/static/")) return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Response("nf", { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  cleanups.push(() => server.stop(true));
  return state;
};

const capture = async (run: () => Promise<number>): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    return { code: await run(), lines };
  } finally {
    console.log = log;
  }
};

const tempHome = (prefix: string): string => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

const setup = async (overrides: Record<string, string> = {}): Promise<{ fake: FakeDiscord; bridge: BridgeHandle; env: Record<string, string> }> => {
  const fake = startFakeDiscord({ heartbeatIntervalMs: 100 });
  cleanups.push(() => fake.stop());
  const home = mkdtempSync(join(tmpdir(), "hent-cmd-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ channelId: CH, guildId: fake.guildId }], dms: false }));
  const env = { HENT_HOME: home, HENT_DISCORD_TOKEN: "fake-token", HENT_DISCORD_API_BASE: fake.apiBase, HENT_DISCORD_GATEWAY: fake.gatewayUrl, ...overrides };
  const bridge = await startBridge({ deliver: { disabled: true }, env, port: 0, logSink: () => {}, configPollMs: 50, sendRetryDelayMs: 10 });
  cleanups.push(() => bridge.stop());
  await waitForEvent(bridge.events, "synced");
  return { fake, bridge, env: { ...env, HENT_BRIDGE_PORT: String(bridge.port) } };
};

const posts = (fake: FakeDiscord) => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/channels/${CH}/messages`));

test("hent send attaches the service-chosen image through the bridge", async () => {
  const { fake, env } = await setup();
  const service = startService();
  const code = await cmdSend(["--to", CH, "--text", "done", "--affect", AFFECT], { ...env, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" });
  expect(code).toBe(0);
  expect(service.requests).toEqual(["POST /v1/final-response/verdict", "GET /static/sets/s/happy-1.png"]);
  const sent = fake.messages(CH).at(-1)!;
  expect(sent.content).toBe("done");
  expect(sent.attachments.map((a) => a.filename)).toEqual(["happy-1.png"]);
});

test("a hanging service costs at most the 2 s deadline and the text still goes out", async () => {
  const { fake, env } = await setup();
  const service = startService();
  service.mode = "hang";
  const started = performance.now();
  expect(await cmdSend(["--to", CH, "--text", "still here", "--affect", AFFECT], { ...env, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" })).toBe(0);
  expect(performance.now() - started).toBeLessThan(2_600);
  expect(fake.messages(CH).at(-1)!.content).toBe("still here");
  expect(fake.messages(CH).at(-1)!.attachments).toEqual([]);
});

test("HENT_ENABLED=0 never calls the service", async () => {
  const { fake, env } = await setup();
  const service = startService();
  expect(await cmdSend(["--to", CH, "--text", "plain", "--affect", AFFECT], { ...env, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t", HENT_ENABLED: "0" })).toBe(0);
  expect(service.requests).toEqual([]);
  expect(fake.messages(CH).at(-1)!.content).toBe("plain");
});

test("--reply-to marks the inbound message handled and a repeated nonce sends once", async () => {
  const { fake, bridge, env } = await setup();
  const inbound = fake.addMessage(CH, { content: "question", viaGateway: true });
  await waitForEvent(bridge.events, "journaled", (e: { messageId: string }) => e.messageId === inbound.id);
  const args = ["--to", CH, "--text", "answer", "--reply-to", inbound.id, "--nonce", "fixednonce1"];
  expect(await cmdSend(args, env)).toBe(0);
  expect(await cmdSend(args, env)).toBe(0);
  expect(posts(fake).length).toBe(1);
  const handled = readFileSync(join(env.HENT_HOME!, "state", "handled.jsonl"), "utf8");
  expect(handled).toContain(inbound.id);
});

test("hent media saves the chosen image into a fresh HENT_HOME and prints its path", async () => {
  const service = startService();
  const home = tempHome("hent-media-");
  const { code, lines } = await capture(() => cmdMedia(["--channel", CH, "--text", "done", "--affect", AFFECT], { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" }));
  expect(code).toBe(0);
  const path = lines.at(-1)!;
  expect(path.startsWith(join(home, "state", "media"))).toBe(true);
  expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
  expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
});

test("hent media --json uses the same fixed base even when the nearest images change", async () => {
  const service = startService();
  service.routing = ROUTING;
  const home = tempHome("hent-media-json-");
  const basePath = join(home, "base.png");
  const baseBytes = new Uint8Array([...PNG, 5]);
  writeFileSync(basePath, baseBytes, { mode: 0o600 });
  const env = { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" };
  const { code, lines } = await capture(() => cmdMedia(["--channel", CH, "--text", "done", "--affect", AFFECT, "--json"], env));
  expect(code).toBe(0);
  expect(lines).toHaveLength(1);
  const out = JSON.parse(lines[0]!) as { path: string; mode: string; distance: number; threshold: number; generate: boolean; references: string[] };
  expect(out).toMatchObject({ mode: "affect-v2", distance: 0.42, threshold: 0.3, generate: true });
  expect(out.path.startsWith(join(home, "state", "media"))).toBe(true);
  expect(new Uint8Array(readFileSync(out.path))).toEqual(PNG);
  expect(out.references).toEqual([basePath]);
  expect(new Uint8Array(readFileSync(basePath))).toEqual(baseBytes);
  expect(service.requests).toEqual(["POST /v1/final-response/verdict", "GET /static/sets/s/happy-1.png"]);

  service.routing = { ...ROUTING, distance: 0.6, nearest: [{ url: "/static/new-image.png", filename: "new-image.png", distance: 0.6 }] };
  const second = await capture(() => cmdMedia(["--channel", CH, "--text", "another mood", "--affect", AFFECT, "--json"], env));
  expect(JSON.parse(second.lines[0]!)).toMatchObject({ generate: true, distance: 0.6, references: [basePath] });
  expect(service.requests.filter((r) => r.startsWith("GET /static/"))).toEqual([
    "GET /static/sets/s/happy-1.png", "GET /static/sets/s/happy-1.png",
  ]);
  expect(new Uint8Array(readFileSync(basePath))).toEqual(baseBytes);
});

for (const state of ["missing", "directory", "invalid"] as const) {
  test(`hent media --json falls back to the chosen image when the fixed base is ${state}`, async () => {
    const service = startService();
    service.routing = ROUTING;
    const home = tempHome("hent-media-base-");
    const basePath = join(home, "base.png");
    if (state === "directory") mkdirSync(basePath);
    if (state === "invalid") writeFileSync(basePath, "not a PNG");
    const { code, lines } = await capture(() => cmdMedia(
      ["--channel", CH, "--text", "done", "--affect", AFFECT, "--json"],
      { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" },
    ));
    const out = JSON.parse(lines[0]!);
    expect(code).toBe(0);
    expect(out).toMatchObject({
      mode: "affect-v2", distance: 0.42, threshold: 0.3, generate: false, references: [],
      reason: state === "invalid" ? "invalid_base_image" : "base_image_unavailable",
    });
    expect(new Uint8Array(readFileSync(out.path))).toEqual(PNG);
    expect(service.requests).toEqual(["POST /v1/final-response/verdict", "GET /static/sets/s/happy-1.png"]);
  });
}

test("hent media --json fetches no references when an existing image fits", async () => {
  const service = startService();
  service.routing = { ...ROUTING, generate: false };
  const home = tempHome("hent-media-fits-");
  const { code, lines } = await capture(() => cmdMedia(["--channel", CH, "--text", "done", "--affect", AFFECT, "--json"], { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" }));
  expect(code).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({ mode: "affect-v2", generate: false, references: [] });
  // Only the chosen image: the reply path pays for one download, not four.
  expect(service.requests).toEqual(["POST /v1/final-response/verdict", "GET /static/sets/s/happy-1.png"]);
});

test("hent media --json gives the reply its send deadline and answers as soon as it runs out", async () => {
  const service = startService();
  service.routing = ROUTING;
  service.mode = "hang";
  const home = tempHome("hent-media-hang-");
  const deadline = new AbortController();
  const run = capture(() => cmdMedia(
    ["--channel", CH, "--text", "done", "--affect", AFFECT, "--json"],
    { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" },
    { reply: () => deadline.signal },
  ));
  await service.firstRequest;
  deadline.abort();

  const { code, lines } = await run;
  expect(code).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({ path: null, generate: false, references: [], reason: "timeout" });
  expect(service.requests).toEqual(["POST /v1/final-response/verdict"]);
  // The verdict and chosen image keep `hent send`'s 2 s budget.
  expect(DEFAULT_MEDIA_DEADLINES.reply).toBe(sendDeadline);
});

test("hent media --json against a service without routing never asks for generation", async () => {
  const service = startService();
  const home = tempHome("hent-media-old-");
  const { code, lines } = await capture(() => cmdMedia(["--channel", CH, "--text", "done", "--affect", AFFECT, "--json"], { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" }));
  expect(code).toBe(0);
  const out = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(out).toMatchObject({ mode: null, distance: null, threshold: null, generate: false, references: [] });
  expect(typeof out.path).toBe("string");
});

test("hent media --json with no image answers with a null path instead of a picture", async () => {
  const home = tempHome("hent-media-none-");
  const { code, lines } = await capture(() => cmdMedia(["--channel", CH, "--text", "done", "--affect", AFFECT, "--json"], { HENT_HOME: home, HENT_URL: "http://127.0.0.1:1", HENT_SERVICE_TOKEN: "t" }));
  expect(code).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({ path: null, generate: false, references: [] });
});

test("hent media refuses a malformed --affect for --json and stays fail-open without it", async () => {
  const service = startService();
  const home = tempHome("hent-media-bad-");
  const env = { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" };
  expect(await cmdMedia(["--channel", CH, "--text", "x", "--affect", "1,2,3|90", "--json"], env)).toBe(2);
  expect(await capture(() => cmdMedia(["--channel", CH, "--text", "x", "--affect", "1,2,3|90"], env))).toEqual({ code: 0, lines: ["NO_MEDIA"] });
  expect(service.requests).toEqual([]);
});

test("hent asset add uploads the file with its tags and prints the new asset id", async () => {
  const service = startService();
  const home = tempHome("hent-asset-");
  const png = join(home, "happy.png");
  writeFileSync(png, PNG);
  const affectFile = join(home, "affect.json");
  writeFileSync(affectFile, JSON.stringify({ schemaVersion: "VisualAffectV2", dimensions: { joy: 0.9 } }));
  const env = { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" };
  const { code, lines } = await capture(() => cmdAsset(["add", "--channel", CH, "--file", png, "--emotion", "happy", "--visual-affect", `@${affectFile}`, "--prompt", "a happy portrait"], env));
  expect(code).toBe(0);
  expect(lines).toEqual(["ASSET native_0123456789ab"]);
  expect(service.assets).toHaveLength(1);
  const body = service.assets[0] as { channelId: string; emotion: string; contentType: string; dataBase64: string; visualAffect: unknown; prompt: string };
  expect(body).toMatchObject({ channelId: CH, emotion: "happy", contentType: "image/png", prompt: "a happy portrait", visualAffect: { schemaVersion: "VisualAffectV2", dimensions: { joy: 0.9 } } });
  expect(new Uint8Array(Buffer.from(body.dataBase64, "base64"))).toEqual(PNG);

  // Inline JSON works the same way.
  const inline = await capture(() => cmdAsset(["add", "--channel", CH, "--file", png, "--emotion", "happy", "--visual-affect", '{"schemaVersion":"VisualAffectV2"}'], env));
  expect(inline.code).toBe(0);
  expect(service.assets).toHaveLength(2);
});

test("hent asset add: malformed tags exit 2, a refused file exits 1, and neither reaches the set", async () => {
  const service = startService();
  const home = tempHome("hent-asset-bad-");
  const png = join(home, "happy.png");
  writeFileSync(png, PNG);
  const env = { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" };
  expect(await cmdAsset(["add", "--channel", CH, "--file", png, "--emotion", "happy", "--visual-affect", "{not json"], env)).toBe(2);
  expect(await cmdAsset(["add", "--channel", CH, "--file", png, "--emotion", "happy", "--visual-affect", "[1,2]"], env)).toBe(2);
  expect(await cmdAsset(["add", "--channel", CH, "--file", png, "--emotion", "happy", "--visual-affect", `@${join(home, "missing.json")}`], env)).toBe(2);
  expect(await cmdAsset(["add", "--channel", CH, "--file", png, "--emotion", "happy"], env)).toBe(2);
  expect(await cmdAsset(["--channel", CH, "--file", png, "--emotion", "happy", "--visual-affect", "{}"], env)).toBe(2);
  expect(service.assets).toEqual([]);

  const text = join(home, "notes.txt");
  writeFileSync(text, "not an image");
  service.assetStatus = 400;
  expect(await cmdAsset(["add", "--channel", CH, "--file", text, "--emotion", "happy", "--visual-affect", "{}"], env)).toBe(1);
  expect(await cmdAsset(["add", "--channel", CH, "--file", join(home, "gone.png"), "--emotion", "happy", "--visual-affect", "{}"], env)).toBe(1);
  expect(service.assets).toHaveLength(1);
});

test("hent typing --for returns at once, the bridge holds the indicator, and a send ends the hold", async () => {
  const { fake, bridge, env } = await setup();
  // Returning while the 20 s hold is still registered is what "at once" means.
  expect(await cmdTyping(["--to", CH, "--for", "20"], env)).toBe(0);
  const typings = () => fake.requests.filter((r) => r.method === "POST" && r.path === `/channels/${CH}/typing`).length;
  expect(typings()).toBe(1);
  expect(bridge.typingHolds()).toBe(1);

  expect(await cmdSend(["--to", CH, "--text", "here"], env)).toBe(0);
  expect(bridge.typingHolds()).toBe(0);

  expect(await cmdTyping(["--to", CH], env)).toBe(0);
  expect(bridge.typingHolds()).toBe(0);
  expect(await cmdTyping(["--to", CH, "--for", "0"], env)).toBe(2);
  expect(await cmdTyping(["--to", CH, "--for", "soon"], env)).toBe(2);
  expect(typings()).toBe(2);
});

test("hent skip records a deliberate non-reply", async () => {
  const { env } = await setup();
  expect(await cmdSkip(["123456789012345678"], env)).toBe(0);
  expect(readFileSync(join(env.HENT_HOME!, "state", "handled.jsonl"), "utf8")).toContain('"how":"skipped"');
});

test("hent skip takes down the typing indicator it would otherwise leave up", async () => {
  const { fake, bridge, env } = await setup();
  const inbound = fake.addMessage(CH, { content: "question", viaGateway: true });
  await waitForEvent(bridge.events, "journaled", (e: { messageId: string }) => e.messageId === inbound.id);
  expect(await cmdTyping(["--to", CH, "--for", "150"], env)).toBe(0);
  expect(bridge.typingHolds()).toBe(1);
  const typings = () => fake.requests.filter((r) => r.method === "POST" && r.path === `/channels/${CH}/typing`).length;
  const held = typings();
  const ended = waitForEvent<string>(bridge.events, "log", (line) => line.includes("BRIDGE_TYPING_HOLD_ENDED"));

  expect(await cmdSkip([inbound.id], env)).toBe(0);

  await ended;
  expect(bridge.typingHolds()).toBe(0);
  expect(typings()).toBe(held);
});

test("hent session set registers the herdr pane it runs in, takes only --agent codex, and refuses without a pane", async () => {
  const { env } = await setup();
  expect(await cmdSession(["set", "--agent", "codex", "--session-id", "abc-123", "--cwd", "/tmp"], { ...env, HERDR_PANE_ID: "w1:p7" })).toBe(0);
  const session = JSON.parse(readFileSync(join(env.HENT_HOME!, "session.json"), "utf8"));
  expect(session).toMatchObject({ agent: "codex", sessionId: "abc-123", pane: "w1:p7", cwd: "/tmp" });
  expect(session.mode).toBeUndefined();
  expect(await cmdSession(["set", "--agent", "codex", "--session-id", "def-456", "--cwd", "/tmp", "--pane", "w2:p1"], env)).toBe(0);
  expect(JSON.parse(readFileSync(join(env.HENT_HOME!, "session.json"), "utf8"))).toMatchObject({ agent: "codex", pane: "w2:p1" });
  // The Claude brain is gone: any other --agent is refused, and so is a run outside a herdr pane.
  expect(await cmdSession(["set", "--agent", "claude", "--session-id", "abc-123", "--cwd", "/tmp", "--pane", "w3:p1"], env)).toBe(2);
  expect(await cmdSession(["set", "--agent", "codex", "--session-id", "abc-123", "--cwd", "/tmp"], env)).toBe(2);
  expect(JSON.parse(readFileSync(join(env.HENT_HOME!, "session.json"), "utf8"))).toMatchObject({ agent: "codex", pane: "w2:p1" });
});

test.each([false, true])("hent session configures the existing Codex thread before registration (rejected=%s)", async (rejected) => {
  const codexHome = tempHome("hent-codex-");
  mkdirSync(join(codexHome, "app-server-control"));
  const { env } = await setup({ CODEX_HOME: codexHome });
  const methods: string[] = [];
  const server = Bun.serve({
    unix: join(codexHome, "app-server-control/app-server-control.sock"),
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        const message = JSON.parse(String(data));
        methods.push(message.method);
        if (message.method === "initialize") ws.send(JSON.stringify({ id: message.id, result: {} }));
        else if (message.method === "thread/settings/update") {
          expect(existsSync(join(env.HENT_HOME!, "session.json"))).toBe(false);
          expect(message.params).toEqual({
            threadId: "existing-thread",
            sandboxPolicy: { type: "workspaceWrite", writableRoots: [env.HENT_HOME], networkAccess: true },
          });
          ws.send(JSON.stringify({
            id: message.id,
            ...(rejected ? { error: { code: -32600, message: "Thread not loaded" } } : { result: {} }),
          }));
        }
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const code = await cmdSession([
    "set", "--agent", "codex", "--session-id", "existing-thread", "--cwd", "/tmp",
    "--pane", "w2:p1", "--configure-codex",
  ], { ...env, CODEX_HOME: codexHome });
  expect(code).toBe(rejected ? 1 : 0);
  expect(existsSync(join(env.HENT_HOME!, "session.json"))).toBe(!rejected);
  if (!rejected) expect(JSON.parse(readFileSync(join(env.HENT_HOME!, "session.json"), "utf8")).configureCodex).toBeUndefined();
  expect(methods).toEqual(["initialize", "initialized", "thread/settings/update"]);
});

test("a stopped bridge makes hent send exit 4 with BRIDGE_DOWN", async () => {
  const home = mkdtempSync(join(tmpdir(), "hent-cmd-down-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "bridge.secret"), "s", { mode: 0o600 });
  expect(await cmdSend(["--to", CH, "--text", "x"], { HENT_HOME: home, HENT_BRIDGE_PORT: "1" })).toBe(4);
});

test("long text is chunked at 2000 chars and the image rides on the last chunk", async () => {
  const { fake, env } = await setup();
  const service = startService();
  const text = `${"a".repeat(1500)} ${"b".repeat(1500)}`;
  expect(chunkText(text).length).toBe(2);
  expect(await cmdSend(["--to", CH, "--text", text, "--affect", AFFECT], { ...env, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" })).toBe(0);
  const [first, second] = fake.messages(CH).slice(-2);
  expect(first!.attachments).toEqual([]);
  expect(second!.attachments.length).toBe(1);
});

test("channels: add lists a channel once with no mode, remove drops it, a legacy mode key is refused by the bridge", async () => {
  const home = mkdtempSync(join(tmpdir(), "hent-ch-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { HENT_HOME: home };
  expect(await cmdChannels(["add", CH, "--guild", "900000000000000001"], env)).toBe(0);
  expect(await cmdChannels(["add", CH], env)).toBe(0);
  expect(readChannels(env).channels).toEqual([{ channelId: CH, guildId: "900000000000000001" }]);
  expect((statSync(join(home, "channels.json")).mode & 0o777).toString(8)).toBe("600");
  expect(await cmdChannels(["set", CH, "reply"], env)).toBe(2);
  expect(await cmdChannels(["import"], env)).toBe(2);
  expect(parseChannelConfig({ channels: [{ channelId: CH, guildId: null, mode: "observe" }], dms: false }).ok).toBe(false);
  expect(await cmdChannels(["remove", CH], env)).toBe(0);
  expect(readChannels(env).channels).toEqual([]);
});
