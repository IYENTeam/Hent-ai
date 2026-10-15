import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InboxEvent, parseHealthResponse, parseInboxResponse } from "../src/bridge/contract.ts";
import { GATEWAY_INTENTS } from "../src/bridge/gateway.ts";
import { type BridgeHandle, type BridgeHooks, startBridge } from "../src/bridge/index.ts";
import { type FakeDiscord, type FakeRequest, startFakeDiscord, waitForEvent } from "./fake-discord.ts";

const CH = "100000000000000001";
const OTHER = "100000000000000002";
const TOKEN = "tok-SECRET-do-not-log";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Setup = { fake: FakeDiscord; bridge: BridgeHandle; home: string; logs: string[]; synced: Promise<unknown> };

const newHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hent-bridge-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

const writeChannels = (home: string, guildId: string, channels = [CH]): void =>
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: channels.map((channelId) => ({ channelId, guildId })), dms: false }));

const startFake = (): FakeDiscord => {
  const fake = startFakeDiscord({ heartbeatIntervalMs: 100 });
  cleanups.push(() => fake.stop());
  return fake;
};

const launch = async (fake: FakeDiscord, home: string, extra: { env?: Record<string, string | undefined>; hooks?: BridgeHooks; tokenRetryMs?: number; typingIntervalMs?: number } = {}): Promise<Setup> => {
  const logs: string[] = [];
  const env = { HENT_HOME: home, HENT_DISCORD_TOKEN: TOKEN, HENT_DISCORD_API_BASE: fake.apiBase, HENT_DISCORD_GATEWAY: fake.gatewayUrl, ...extra.env };
  const bridge = await startBridge({ deliver: { disabled: true },
    env,
    port: 0,
    logSink: (line) => logs.push(line),
    configPollMs: 50,
    tokenRetryMs: extra.tokenRetryMs ?? 60_000,
    gateway: { reconnectDelayMs: () => 20, invalidSessionDelayMs: () => 20, random: () => 0.5 },
    sendRetryDelayMs: 10,
    ...(extra.typingIntervalMs !== undefined ? { typingIntervalMs: extra.typingIntervalMs } : {}),
    ...(extra.hooks ? { hooks: extra.hooks } : {}),
  });
  const synced = waitForEvent(bridge.events, "synced");
  cleanups.push(() => bridge.stop());
  return { fake, bridge, home, logs, synced };
};

const setup = async (opts: { seed?: number } = {}): Promise<Setup> => {
  const fake = startFake();
  if (opts.seed) fake.seed(CH, opts.seed);
  const home = newHome();
  writeChannels(home, fake.guildId);
  const s = await launch(fake, home);
  await s.synced;
  return s;
};

const api = (bridge: BridgeHandle, path: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    ...init,
    headers: { ...(init.auth === false ? {} : { authorization: `Bearer ${bridge.secret}` }), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });

const journaled = (bridge: BridgeHandle, messageId: string): Promise<InboxEvent> => waitForEvent<InboxEvent>(bridge.events, "journaled", (e) => e.messageId === messageId);

const inboxLines = (home: string): InboxEvent[] =>
  readFileSync(join(home, "state", "inbox.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as InboxEvent);

const mode = (path: string): number => statSync(path).mode & 0o777;

test("IDENTIFY carries exactly GUILDS|GUILD_MESSAGES|DIRECT_MESSAGES|MESSAGE_CONTENT and heartbeats are ACKed", async () => {
  const { fake, bridge, logs } = await setup();
  expect(GATEWAY_INTENTS).toBe(1 | 512 | 4096 | 32768);
  const identify = fake.frames.find((f) => f.op === 2);
  expect((identify?.d as { intents: number; token: string }).intents).toBe(1 | 512 | 4096 | 32768);
  expect((identify?.d as { token: string }).token).toBe(TOKEN);
  await waitForEvent(bridge.events, "heartbeat_ack");
  expect(fake.frames.some((f) => f.op === 1)).toBe(true);
  expect(bridge.gatewayState()).toBe("connected");
  expect(logs.join("\n")).not.toContain(TOKEN);
});

test("MESSAGE_CREATE in a configured channel is journaled (and fsynced to inbox.jsonl); other channels are not", async () => {
  const { fake, bridge, home } = await setup();
  const next = waitForEvent<InboxEvent>(bridge.events, "journaled");
  fake.addMessage(OTHER, { content: "not bridged" });
  const message = fake.addMessage(CH, { content: "hello $(id)" });
  const event = await next;
  expect(event).toMatchObject({
    seq: 1,
    kind: "message_create",
    channelId: CH,
    guildId: fake.guildId,
    messageId: message.id,
    authorIsBot: false,
    authorIsSelf: false,
    authorName: "human",
    content: "hello $(id)",
    referencedMessageId: null,
  });
  expect(inboxLines(home)).toEqual([event]);
});

test("the bot's own messages are journaled with authorIsSelf", async () => {
  const { fake, bridge } = await setup();
  const own = fake.addMessage(CH, { content: "my reply", author: fake.botUser });
  const event = await journaled(bridge, own.id);
  expect(event.authorIsSelf).toBe(true);
  expect(event.authorIsBot).toBe(true);
});

test("a forced close is followed by RESUME, and the event missed meanwhile is replayed once", async () => {
  const { fake, bridge } = await setup();
  const m1 = fake.addMessage(CH, { content: "one" });
  await journaled(bridge, m1.id);
  const resumed = waitForEvent<string>(bridge.events, "log", (l) => l.includes("BRIDGE_RESUMED"));
  fake.closeSockets(4000);
  const m2 = fake.addMessage(CH, { content: "two" });
  const second = journaled(bridge, m2.id);
  await resumed;
  await second;
  const resume = fake.frames.filter((f) => f.op === 6);
  expect(resume).toHaveLength(1);
  expect((resume[0]?.d as { session_id: string }).session_id).toMatch(/^sess-/);
  expect(fake.frames.filter((f) => f.op === 2)).toHaveLength(1);
  expect(bridge.journal.after(0, 100).map((e) => [e.seq, e.messageId])).toEqual([
    [1, m1.id],
    [2, m2.id],
  ]);
});

test("a rejected RESUME re-identifies and backfills the missed message over REST exactly once", async () => {
  const { fake, bridge } = await setup();
  const m1 = fake.addMessage(CH, { content: "before" });
  await journaled(bridge, m1.id);
  fake.rejectResume = true;
  const resynced = waitForEvent(bridge.events, "synced");
  fake.closeSockets(4000);
  const m2 = fake.addMessage(CH, { content: "missed", viaGateway: false });
  await resynced;
  expect(fake.frames.filter((f) => f.op === 6)).toHaveLength(1);
  expect(fake.frames.filter((f) => f.op === 2)).toHaveLength(2);
  const backfills = fake.requests.filter((r) => r.method === "GET" && r.path === `/channels/${CH}/messages` && r.query.after === m1.id);
  expect(backfills).toHaveLength(1);
  expect(bridge.journal.after(0, 100).map((e) => e.messageId)).toEqual([m1.id, m2.id]);
  const m3 = fake.addMessage(CH, { content: "live again" });
  await journaled(bridge, m3.id);
  expect(bridge.journal.after(0, 100).map((e) => e.messageId)).toEqual([m1.id, m2.id, m3.id]);
});

test("first start on a channel with 50 messages journals nothing; a restart backfills only what came after", async () => {
  const { fake, bridge, home } = await setup({ seed: 50 });
  expect(bridge.journal.lastSeq).toBe(0);
  expect(inboxLines(home)).toEqual([]);
  expect(fake.requests.filter((r) => r.path === `/channels/${CH}/messages` && r.query.limit === "1" && r.query.after === undefined)).toHaveLength(1);

  const live = fake.addMessage(CH, { content: "new" });
  expect((await journaled(bridge, live.id)).seq).toBe(1);

  await bridge.stop();
  const whileDown = [fake.addMessage(CH, { content: "a", viaGateway: false }), fake.addMessage(CH, { content: "b", viaGateway: false })];
  const again = await launch(fake, home);
  await again.synced;
  expect(again.bridge.journal.after(0, 100).map((e) => [e.seq, e.messageId])).toEqual([
    [1, live.id],
    [2, whileDown[0]!.id],
    [3, whileDown[1]!.id],
  ]);
});

test("close code 4014 is fatal: no reconnect, health reports fatal, sends answer 503", async () => {
  const { fake, bridge, logs } = await setup();
  const fatal = waitForEvent(bridge.events, "state", (s) => s === "fatal");
  fake.closeSockets(4014, "Disallowed intent(s)");
  await fatal;
  expect(bridge.gateway()?.active()).toBe(false);
  expect(fake.connections()).toBe(1);
  expect(logs.some((l) => l.includes("BRIDGE_FATAL code=4014"))).toBe(true);
  const health = parseHealthResponse(await (await api(bridge, "/v1/health", { auth: false })).json());
  expect(health.ok && health.value.gateway).toBe("fatal");
  const send = await api(bridge, "/v1/send", { method: "POST", body: JSON.stringify({ channelId: CH, text: "hi", nonce: "n1" }) });
  expect(send.status).toBe(503);
  expect(await send.json()).toMatchObject({ error: "gateway_fatal" });
});

test("a repeated nonce sends once, also across a bridge restart, and replyTo marks the message handled", async () => {
  const { fake, bridge, home } = await setup();
  const inbound = fake.addMessage(CH, { content: "question" });
  await journaled(bridge, inbound.id);
  const body = JSON.stringify({ channelId: CH, text: "answer", replyToMessageId: inbound.id, nonce: "abc123_x-0" });
  const first = (await (await api(bridge, "/v1/send", { method: "POST", body })).json()) as { messageId: string };
  const second = (await (await api(bridge, "/v1/send", { method: "POST", body })).json()) as { messageId: string };
  expect(second.messageId).toBe(first.messageId);
  const posts = () => fake.requests.filter((r) => r.method === "POST" && r.path === `/channels/${CH}/messages`);
  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.body).toMatchObject({ content: "answer", nonce: "abc123_x-0", enforce_nonce: true, message_reference: { message_id: inbound.id } });
  const handled = readFileSync(join(home, "state", "handled.jsonl"), "utf8").trim().split("\n");
  expect(handled).toHaveLength(1);
  expect(JSON.parse(handled[0]!)).toMatchObject({ messageId: inbound.id, how: "replied" });

  await bridge.stop();
  const again = await launch(fake, home);
  await again.synced;
  const third = (await (await api(again.bridge, "/v1/send", { method: "POST", body })).json()) as { messageId: string };
  expect(third.messageId).toBe(first.messageId);
  expect(posts()).toHaveLength(1);
});

test("a held typing indicator is re-sent on every tick and stops when the bridge posts to that channel", async () => {
  const fake = startFake();
  const home = newHome();
  writeChannels(home, fake.guildId);
  const { bridge, synced, logs } = await launch(fake, home, { typingIntervalMs: 200 });
  await synced;
  const typings = (): number => fake.requests.filter((r) => r.method === "POST" && r.path === `/channels/${CH}/typing`).length;
  let seen = 0;
  const thirdTyping = waitForEvent<FakeRequest>(fake.events, "request", (r) => r.path === `/channels/${CH}/typing` && ++seen === 3);

  const held = await api(bridge, "/v1/typing", { method: "POST", body: JSON.stringify({ channelId: CH, forSeconds: 5 }) });
  expect(held.status).toBe(204);
  expect(typings()).toBe(1);
  expect(bridge.typingHolds()).toBe(1);

  await thirdTyping;
  expect(logs.some((l) => l.includes("BRIDGE_TYPING_HOLD channelId=") && l.includes("forSeconds=5"))).toBe(true);

  const send = await api(bridge, "/v1/send", { method: "POST", body: JSON.stringify({ channelId: CH, text: "answer", nonce: "holdstop1" }) });
  expect(send.status).toBe(200);
  expect(bridge.typingHolds()).toBe(0);
  expect(logs.some((l) => l.includes("BRIDGE_TYPING_HOLD_STOPPED") && l.includes("reason=sent"))).toBe(true);
  const afterSend = typings();
  await waitForEvent<FakeRequest>(fake.events, "request", (r) => r.path === `/channels/${CH}/typing`, 600).catch(() => null);
  expect(typings()).toBe(afterSend);
});

test("a one-shot typing request starts no hold, and an unknown hold field is refused", async () => {
  const { bridge } = await setup();
  expect((await api(bridge, "/v1/typing", { method: "POST", body: JSON.stringify({ channelId: CH }) })).status).toBe(204);
  expect(bridge.typingHolds()).toBe(0);
  const bad = await api(bridge, "/v1/typing", { method: "POST", body: JSON.stringify({ channelId: CH, forSeconds: 601 }) });
  expect(bad.status).toBe(400);
  expect(bridge.typingHolds()).toBe(0);
});

test("multipart send uploads the file to Discord", async () => {
  const { fake, bridge } = await setup();
  const form = new FormData();
  form.append("payload", JSON.stringify({ channelId: CH, text: "", nonce: "media1" }));
  form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "happy.png", { type: "image/png" }));
  const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/send`, { method: "POST", body: form, headers: { authorization: `Bearer ${bridge.secret}` } });
  expect(res.status).toBe(200);
  const post = fake.requests.find((r) => r.method === "POST" && r.path === `/channels/${CH}/messages`);
  expect(post?.body).toMatchObject({ nonce: "media1", enforce_nonce: true, file: "happy.png" });
});

test("without a token the bridge keeps serving and retries until a 0600 token file appears", async () => {
  const fake = startFake();
  const home = newHome();
  writeChannels(home, fake.guildId);
  writeFileSync(join(home, "discord.token"), `${TOKEN}\n`, { mode: 0o644 });
  chmodSync(join(home, "discord.token"), 0o644);
  let misses = 0;
  const { bridge, logs } = await launch(fake, home, { env: { HENT_DISCORD_TOKEN: undefined }, tokenRetryMs: 20 });
  await waitForEvent<string>(bridge.events, "log", (l) => l.includes("BRIDGE_NO_TOKEN") && ++misses >= 3);
  expect(logs.some((l) => l.includes("BRIDGE_TOKEN_REFUSED") && l.includes("0600"))).toBe(true);
  const health = parseHealthResponse(await (await api(bridge, "/v1/health", { auth: false })).json());
  expect(health.ok && health.value.gateway).toBe("reconnecting");
  expect(fake.connections()).toBe(0);

  const connected = waitForEvent(bridge.events, "state", (s) => s === "connected");
  chmodSync(join(home, "discord.token"), 0o600);
  await connected;
  expect(logs.some((l) => l.includes("BRIDGE_TOKEN_LOADED source=file"))).toBe(true);
  expect(logs.join("\n")).not.toContain(TOKEN);
});

test("HENT_HOME dirs are 0700 and every bridge file is 0600", async () => {
  const fake = startFake();
  const home = newHome();
  chmodSync(home, 0o755);
  writeChannels(home, fake.guildId);
  const { bridge, synced } = await launch(fake, home);
  await synced;
  const m = fake.addMessage(CH, { content: "x" });
  await journaled(bridge, m.id);
  await api(bridge, "/v1/send", { method: "POST", body: JSON.stringify({ channelId: CH, text: "y", replyToMessageId: m.id, nonce: "modes" }) });
  await api(bridge, "/v1/inbox?consumer=qa&ack=1");
  await api(bridge, "/v1/session", { method: "POST", body: JSON.stringify({ agent: "codex", sessionId: "s1", pane: "w1:p1", cwd: "/tmp" }) });
  for (const dir of [home, join(home, "state"), join(home, "state", "consumers")]) expect(mode(dir)).toBe(0o700);
  for (const file of ["bridge.secret", "session.json", "state/inbox.jsonl", "state/journal-state.json", "state/sent.jsonl", "state/handled.jsonl", "state/consumers/qa.json"]) {
    expect([file, mode(join(home, file))]).toEqual([file, 0o600]);
  }
});

test("local API: bearer required, inbox ack/long-poll/lease, history, session hook, onJournaled hook", async () => {
  const fake = startFake();
  const home = newHome();
  mkdirSync(home, { recursive: true });
  writeChannels(home, fake.guildId);
  const seen: string[] = [];
  const sessions: string[] = [];
  const { bridge, synced } = await launch(fake, home, { hooks: { onJournaled: (e) => seen.push(e.messageId), onSessionSet: (s) => sessions.push(s.sessionId) } });
  await synced;

  expect((await api(bridge, "/v1/inbox?consumer=a", { auth: false })).status).toBe(401);
  expect((await api(bridge, "/v1/health", { auth: false })).status).toBe(200);
  expect((await api(bridge, "/v1/inbox?consumer=a&wait=26")).status).toBe(400);

  const waiting = waitForEvent<string>(bridge.events, "log", (l) => l.includes("BRIDGE_INBOX_WAIT consumer=a"));
  const poll = api(bridge, "/v1/inbox?consumer=a&wait=5");
  await waiting;
  const conflict = await api(bridge, "/v1/inbox?consumer=a");
  expect(conflict.status).toBe(409);
  const m1 = fake.addMessage(CH, { content: "first" });
  const woke = parseInboxResponse(await (await poll).json());
  expect(woke.ok && woke.value.events.map((e) => e.messageId)).toEqual([m1.id]);

  const m2 = fake.addMessage(CH, { content: "second" });
  await journaled(bridge, m2.id);
  const acked = parseInboxResponse(await (await api(bridge, "/v1/inbox?consumer=a&ack=1")).json());
  expect(acked.ok && acked.value).toMatchObject({ cursor: 1, events: [{ seq: 2, messageId: m2.id }] });
  const lowerAck = parseInboxResponse(await (await api(bridge, "/v1/inbox?consumer=a&ack=0")).json());
  expect(lowerAck.ok && lowerAck.value.cursor).toBe(1);

  const history = (await (await api(bridge, `/v1/history?channelId=${CH}&limit=1`)).json()) as { events: InboxEvent[] };
  expect(history.events.map((e) => e.messageId)).toEqual([m2.id]);
  expect(seen).toEqual([m1.id, m2.id]);

  expect((await api(bridge, "/v1/handled", { method: "POST", body: JSON.stringify({ messageId: m2.id, how: "skipped" }) })).status).toBe(204);
  const res = await api(bridge, "/v1/session", { method: "POST", body: JSON.stringify({ agent: "codex", sessionId: "sess-9", pane: "w3:p2", cwd: "/work" }) });
  expect(res.status).toBe(204);
  expect(sessions).toEqual(["sess-9"]);
  expect(JSON.parse(readFileSync(join(home, "session.json"), "utf8"))).toMatchObject({ agent: "codex", sessionId: "sess-9", pane: "w3:p2", cwd: "/work" });
  const health = parseHealthResponse(await (await api(bridge, "/v1/health", { auth: false })).json());
  expect(health.ok && health.value).toMatchObject({ gateway: "connected", botUserId: fake.botUser.id, lastSeq: 2, consumers: [{ name: "a", cursor: 1 }] });
});
