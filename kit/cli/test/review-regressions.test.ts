import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxEvent } from "../src/bridge/contract.ts";
import type { QueueRpc } from "../src/bridge/codex-queue.ts";
import { type BridgeHandle, startBridge } from "../src/bridge/index.ts";
import { cmdChannels, cmdSend, cmdSession, LAUNCHD_TEMPLATE, readChannels } from "../src/commands.ts";
import { fetchHttp, type Http } from "../src/messenger/http.ts";
import { type FakeDiscord, startFakeDiscord, waitForEvent } from "./fake-discord.ts";

const CH = "100000000000000001";
const AFFECT = `${Array(24).fill(40).join(",")}|90`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const tempHome = (prefix: string): string => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

type ServiceMode = { body: Uint8Array; sensitive: boolean };

const startService = (mode: Partial<ServiceMode> = {}) => {
  const m: ServiceMode = { body: PNG, sensitive: false, ...mode };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/final-response/verdict") {
        return Response.json({ verdict: { media: { url: "/static/s/happy-1.png", filename: "happy-1.png", contentType: "image/png", sensitiveMedia: m.sensitive } } });
      }
      if (path === "/static/s/happy-1.png") {
        return new Response(m.body, { headers: { "content-type": "image/png" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
};

const setup = async (opts: { http?: Http; guildId?: string | null; deliver?: boolean; connect?: () => Promise<QueueRpc> } = {}) => {
  const fake = startFakeDiscord({ heartbeatIntervalMs: 100 });
  cleanups.push(() => fake.stop());
  const home = tempHome("hent-rr-");
  const guildId = opts.guildId === undefined ? fake.guildId : opts.guildId;
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ channelId: CH, guildId }], dms: false }));
  const env = { HENT_HOME: home, HENT_DISCORD_TOKEN: "fake-token", HENT_DISCORD_API_BASE: fake.apiBase, HENT_DISCORD_GATEWAY: fake.gatewayUrl };
  const logs: string[] = [];
  const bridge = await startBridge({
    deliver: opts.deliver ? { retryMs: 20, isLive: async () => true, ...(opts.connect ? { connect: opts.connect } : {}) } : { disabled: true },
    env,
    port: 0,
    logSink: (line) => logs.push(line),
    configPollMs: 50,
    sendRetryDelayMs: 10,
    ...(opts.http ? { http: opts.http } : {}),
  });
  cleanups.push(() => bridge.stop());
  await waitForEvent(bridge.events, "synced");
  return { fake, bridge, home, logs, env: { ...env, HENT_BRIDGE_PORT: String(bridge.port) } };
};

const handledIds = (home: string): string[] =>
  existsSync(join(home, "state", "handled.jsonl"))
    ? readFileSync(join(home, "state", "handled.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { messageId: string }).messageId)
    : [];

const inbound = async (fake: FakeDiscord, bridge: BridgeHandle, content: string) => {
  const message = fake.addMessage(CH, { content, viaGateway: true });
  await waitForEvent<InboxEvent>(bridge.events, "journaled", (e) => e.messageId === message.id);
  return message;
};

test("an empty image from the service still lets the text reply go out", async () => {
  const { fake, env } = await setup();
  const url = startService({ body: new Uint8Array() });
  expect(await cmdSend(["--to", CH, "--text", "still answering", "--affect", AFFECT], { ...env, HENT_URL: url, HENT_SERVICE_TOKEN: "t" })).toBe(0);
  const last = fake.messages(CH).at(-1)!;
  expect(last.content).toBe("still answering");
  expect(last.attachments).toEqual([]);
});

test("sensitive media is sent as a spoiler attachment", async () => {
  const { fake, env } = await setup();
  const url = startService({ sensitive: true });
  expect(await cmdSend(["--to", CH, "--text", "careful", "--affect", AFFECT], { ...env, HENT_URL: url, HENT_SERVICE_TOKEN: "t" })).toBe(0);
  expect(fake.messages(CH).at(-1)!.attachments.map((a) => a.filename)).toEqual(["SPOILER_happy-1.png"]);
});

test("verdict and download share one 2 s deadline and expiration sends plain text", async () => {
  // Given a real service that starts its media response but does not finish it.
  const { fake, env } = await setup();
  const mediaRequested = Promise.withResolvers<void>();
  const finishMedia = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/v1/final-response/verdict") {
        return Response.json({ verdict: { media: { url: "/static/happy.png", filename: "happy.png", contentType: "image/png" } } });
      }
      mediaRequested.resolve();
      await finishMedia.promise;
      return new Response(PNG);
    },
  });
  cleanups.push(async () => { finishMedia.resolve(); await server.stop(true); });
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const budgets: AbortController[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    if (milliseconds !== 2_000) return nativeTimeout(milliseconds);
    const budget = new AbortController();
    budgets.push(budget);
    return budget.signal;
  });
  try {
    // When the one 2000 ms deadline expires after the verdict, during download.
    const sent = cmdSend(["--to", CH, "--text", "budget", "--affect", AFFECT], {
      ...env, HENT_URL: `http://127.0.0.1:${server.port}`, HENT_SERVICE_TOKEN: "t",
    });
    await mediaRequested.promise;
    expect(budgets).toHaveLength(1);
    budgets[0]?.abort();

    // Then no second download budget is created and the real bridge sends plain text.
    expect(await sent).toBe(0);
    expect(budgets).toHaveLength(1);
    expect(fake.messages(CH).at(-1)).toMatchObject({ content: "budget", attachments: [] });
  } finally {
    for (const budget of budgets) budget.abort();
    timeout.mockRestore();
  }
});

test("a malformed --affect exits 2 and sends nothing", async () => {
  const { fake, env } = await setup();
  const before = fake.messages(CH).length;
  expect(await cmdSend(["--to", CH, "--text", "x", "--affect", `${Array(23).fill(1).join(",")}|90`], env)).toBe(2);
  expect(fake.messages(CH).length).toBe(before);
});

test("a reply whose second chunk fails leaves the inbound message unhandled", async () => {
  let posts = 0;
  const failingSecond: Http = async (req) => {
    if (req.method === "POST" && req.url.endsWith(`/channels/${CH}/messages`)) {
      posts += 1;
      if (posts === 2) return { status: 403, headers: {}, body: JSON.stringify({ message: "Missing Permissions", code: 50013 }) };
    }
    return fetchHttp(req);
  };
  const { fake, bridge, home, env } = await setup({ http: failingSecond });
  const question = await inbound(fake, bridge, "long question");
  const text = `${"a".repeat(1500)} ${"b".repeat(1500)}`;
  expect(await cmdSend(["--to", CH, "--text", text, "--reply-to", question.id], env)).toBe(1);
  expect(handledIds(home)).not.toContain(question.id);
});

test("a complete multi-chunk reply marks the inbound message handled only after the last chunk", async () => {
  const { fake, bridge, home, env } = await setup();
  const question = await inbound(fake, bridge, "another question");
  const text = `${"a".repeat(1500)} ${"b".repeat(1500)}`;
  expect(await cmdSend(["--to", CH, "--text", text, "--reply-to", question.id], env)).toBe(0);
  const [first, second] = fake.messages(CH).slice(-2);
  expect(first!.message_reference).toBeUndefined();
  expect(second!.message_reference?.message_id).toBe(question.id);
  expect(handledIds(home)).toContain(question.id);
});

test("an imported channel without a guild id is seeded on first start and backfilled after a restart", async () => {
  const fake = startFakeDiscord({ heartbeatIntervalMs: 100 });
  cleanups.push(() => fake.stop());
  fake.seed(CH, 50);
  const home = tempHome("hent-rr-import-");
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ channelId: CH, guildId: null }], dms: false }));
  const env = { HENT_HOME: home, HENT_DISCORD_TOKEN: "fake-token", HENT_DISCORD_API_BASE: fake.apiBase, HENT_DISCORD_GATEWAY: fake.gatewayUrl };
  const start = async () => {
    const b = await startBridge({ deliver: { disabled: true }, env, port: 0, logSink: () => {}, configPollMs: 50 });
    await waitForEvent(b.events, "synced");
    return b;
  };
  const first = await start();
  expect(first.journal.lastSeq).toBe(0);
  await first.stop();
  const missed = fake.addMessage(CH, { content: "while the bridge was down", viaGateway: false });
  const second = await start();
  cleanups.push(() => second.stop());
  expect(second.journal.after(0, 100).map((e) => e.messageId)).toEqual([missed.id]);
});

test("removing a channel stops journaling it; an invalid channels.json keeps the previous config", async () => {
  const { fake, bridge, logs, env } = await setup();
  writeFileSync(join(env.HENT_HOME, "channels.json"), "{ not json");
  await waitForEvent<string>(bridge.events, "log", (line) => line.includes("BRIDGE_CONFIG_INVALID"));
  await inbound(fake, bridge, "still listening");
  writeFileSync(join(env.HENT_HOME, "channels.json"), JSON.stringify({ channels: [{ channelId: CH, guildId: fake.guildId }], dms: false }));
  await waitForEvent<string>(bridge.events, "log", (line) => line.includes("BRIDGE_CONFIG_LOADED"));
  expect(await cmdChannels(["remove", CH], env)).toBe(0);
  await waitForEvent<string>(bridge.events, "log", (line) => line.includes("BRIDGE_CONFIG_LOADED channels=0"));
  const before = bridge.journal.lastSeq;
  const ignored = fake.addMessage(CH, { content: "after removal", viaGateway: true });
  const seen: string[] = [];
  bridge.events.on("journaled", (e: InboxEvent) => seen.push(e.messageId));
  const marker = fake.addMessage("100000000000000999", { content: "unconfigured channel", viaGateway: true });
  await Bun.sleep(100);
  expect(bridge.journal.lastSeq).toBe(before);
  expect(seen).not.toContain(ignored.id);
  expect(seen).not.toContain(marker.id);
  expect(logs.some((l) => l.includes("BRIDGE_CONFIG_INVALID"))).toBe(true);
});

test("a native wake consumes the real inbox CLI and skips its message exactly once", async () => {
  const calls: string[] = [];
  let envForChild: Record<string, string> = {};
  const command = async (args: readonly string[]): Promise<string> => {
    const child = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, ...envForChild, CODEX_THREAD_ID: "abc-123" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    return stdout;
  };
  const connect = async (): Promise<QueueRpc> => ({
    async request(method, params) {
      calls.push(method);
      if (method === "thread/read") return { thread: { status: { type: "idle" } } };
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (method !== "thread/queue/add") throw new Error(`unexpected method ${method}`);
      if (typeof params !== "object" || params === null || !("clientUserMessageId" in params) || typeof params.clientUserMessageId !== "string") throw new Error("missing wake ID");
      const wakeId = params.clientUserMessageId;
      const response: { events: InboxEvent[] } = JSON.parse(await command(["inbox", "next", "--wake", wakeId]));
      const message = response.events[0];
      if (!message) throw new Error("missing pending message");
      await command(["skip", message.messageId]);
      expect(JSON.parse(await command(["inbox", "done", "--wake", wakeId]))).toEqual({ continue: false });
      return { queuedSubmission: { id: "native-queue-entry" } };
    },
    subscribe: () => () => {},
    onClose: () => () => {},
    close: () => {},
  });
  const { fake, bridge, home, env } = await setup({ deliver: true, connect });
  envForChild = env;
  expect(await cmdSession(["set", "--agent", "codex", "--session-id", "abc-123", "--cwd", "/tmp", "--pane", "w1:p1"], env)).toBe(0);
  const delivered = waitForEvent<string>(bridge.events, "log", (line) => line.includes("BRIDGE_WAKE_QUEUED"), 10_000);
  const question = await inbound(fake, bridge, "please answer");
  await delivered;
  expect(calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
  expect(handledIds(home)).toContain(question.id);
});

test.if(process.platform === "darwin")("the launchd plist renders without a token and passes plutil -lint", async () => {
  const home = tempHome("hent-rr-plist-");
  const plist = LAUNCHD_TEMPLATE("/opt/bun/bin/bun", "/x/kit/cli/src/cli.ts", home, "/Users/me");
  // The user's ~/.local/bin comes first so the bridge runs the same herdr as the live session.
  expect(plist).toContain("<key>PATH</key><string>/Users/me/.local/bin:/opt/homebrew/bin:");
  const path = join(home, "ai.hent.bridge.plist");
  writeFileSync(path, plist);
  const lint = Bun.spawn(["plutil", "-lint", path], { stdout: "pipe" });
  expect(await lint.exited).toBe(0);
  expect(/token/i.test(plist)).toBe(false);
});
