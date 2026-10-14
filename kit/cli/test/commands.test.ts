import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BridgeHandle, startBridge } from "../src/bridge/index.ts";
import { chunkText, cmdChannels, cmdMedia, cmdSend, cmdSession, cmdSkip, importedChannels, readChannels } from "../src/commands.ts";
import { type FakeDiscord, startFakeDiscord, waitForEvent } from "./fake-discord.ts";

const CH = "100000000000000001";
const AFFECT = `${Array(24).fill(40).join(",")}|90`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Service = { url: string; requests: string[]; mode: "media" | "hang" | "down" };

const startService = (): Service => {
  const state: Service = { url: "", requests: [], mode: "media" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      state.requests.push(`${req.method} ${path}`);
      if (state.mode === "hang") await Bun.sleep(5_000);
      if (path === "/v1/final-response/verdict") {
        return Response.json({ verdict: { media: { url: "/static/sets/s/happy-1.png", filename: "happy-1.png", contentType: "image/png", sensitiveMedia: false } } });
      }
      if (path === "/static/sets/s/happy-1.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Response("nf", { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  cleanups.push(() => server.stop(true));
  return state;
};

const setup = async (): Promise<{ fake: FakeDiscord; bridge: BridgeHandle; env: Record<string, string> }> => {
  const fake = startFakeDiscord({ heartbeatIntervalMs: 100 });
  cleanups.push(() => fake.stop());
  const home = mkdtempSync(join(tmpdir(), "hent-cmd-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ channelId: CH, guildId: fake.guildId, mode: "reply" }], dms: false }));
  const env = { HENT_HOME: home, HENT_DISCORD_TOKEN: "fake-token", HENT_DISCORD_API_BASE: fake.apiBase, HENT_DISCORD_GATEWAY: fake.gatewayUrl };
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
  const home = mkdtempSync(join(tmpdir(), "hent-media-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await cmdMedia(["--channel", CH, "--text", "done", "--affect", AFFECT], { HENT_HOME: home, HENT_URL: service.url, HENT_SERVICE_TOKEN: "t" })).toBe(0);
  } finally {
    console.log = log;
  }
  const path = lines.at(-1)!;
  expect(path.startsWith(join(home, "state", "media"))).toBe(true);
  expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
  expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
});

test("hent skip records a deliberate non-reply", async () => {
  const { env } = await setup();
  expect(await cmdSkip(["123456789012345678"], env)).toBe(0);
  expect(readFileSync(join(env.HENT_HOME!, "state", "handled.jsonl"), "utf8")).toContain('"how":"skipped"');
});

test("hent session set registers the herdr pane it runs in, and refuses without one", async () => {
  const { env } = await setup();
  expect(await cmdSession(["set", "--agent", "claude", "--session-id", "abc-123", "--cwd", "/tmp"], { ...env, HERDR_PANE_ID: "w1:p7" })).toBe(0);
  const session = JSON.parse(readFileSync(join(env.HENT_HOME!, "session.json"), "utf8"));
  expect(session).toMatchObject({ agent: "claude", sessionId: "abc-123", pane: "w1:p7", cwd: "/tmp" });
  expect(session.mode).toBeUndefined();
  expect(await cmdSession(["set", "--agent", "codex", "--session-id", "def-456", "--cwd", "/tmp", "--pane", "w2:p1"], env)).toBe(0);
  expect(JSON.parse(readFileSync(join(env.HENT_HOME!, "session.json"), "utf8"))).toMatchObject({ agent: "codex", pane: "w2:p1" });
  expect(await cmdSession(["set", "--agent", "claude", "--session-id", "abc-123", "--cwd", "/tmp"], env)).toBe(2);
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

test("channels: import lands as observe with tunables, set flips one, remove drops it", async () => {
  const home = mkdtempSync(join(tmpdir(), "hent-ch-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { HENT_HOME: home };
  const next = importedChannels(
    [
      { channelId: CH, enabled: true, settings: { ambientBudgetPerHour: 5, unrelated: 1 } },
      { channelId: "100000000000000002", enabled: false },
      { channelId: "not-a-snowflake", enabled: true },
    ],
    { channels: [], dms: false },
  );
  expect(next.channels).toEqual([{ channelId: CH, guildId: null, mode: "observe", tunables: { ambientBudgetPerHour: 5 } }]);
  writeFileSync(join(home, "channels.json"), JSON.stringify(next));
  expect(await cmdChannels(["set", CH, "reply"], env)).toBe(0);
  expect(readChannels(env).channels[0]!.mode).toBe("reply");
  expect((statSync(join(home, "channels.json")).mode & 0o777).toString(8)).toBe("600");
  expect(await cmdChannels(["remove", CH], env)).toBe(0);
  expect(readChannels(env).channels).toEqual([]);
});
