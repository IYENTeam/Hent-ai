import { expect, test } from "bun:test";

import { Discord, DISCORD_API_BASE, discordApiBase } from "../src/messenger/discord.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { fakeClock, fakeHttp, ok } from "./fakes.ts";

const BASE = "https://discord.test/api/v10";
const path = (url: string) => url.replace(BASE, "");

test("a send that hits 429 waits retry-after seconds, retries, and returns the message id", async () => {
  const { http, seen } = fakeHttp((_, n) => (n === 1 ? ok({ message: "rate limited", retry_after: 9 }, 429, { "retry-after": "3" }) : ok({ id: "M1" })));
  const clock = fakeClock(0);
  expect(await new Discord(http, clock, "tok", BASE).send("C1", "hi")).toBe("M1");
  expect(clock.waited).toEqual([3000]);
  expect(seen).toHaveLength(2);
});

test("without a retry-after header the body's retry_after is honored", async () => {
  const { http } = fakeHttp((_, n) => (n === 1 ? ok({ retry_after: 1.5 }, 429) : ok({ id: "M2" })));
  const clock = fakeClock(0);
  await new Discord(http, clock, "tok", BASE).send("C1", "hi");
  expect(clock.waited).toEqual([1500]);
});

test("send carries no-ping mentions, a reply reference, and an enforced nonce in the JSON body", async () => {
  const { http, seen } = fakeHttp(() => ok({ id: "M1" }));
  await new Discord(http, fakeClock(0), "tok", BASE).send("C1", "hello @everyone", { replyToMessageId: "U9", nonce: "n-abc-0" });
  const req = seen[0]!;
  expect(`${req.method} ${path(req.url)}`).toBe("POST /channels/C1/messages");
  expect(req.headers).toMatchObject({ Authorization: "Bot tok", "Content-Type": "application/json" });
  expect(JSON.parse(String(req.body))).toEqual({
    content: "hello @everyone",
    allowed_mentions: { parse: [] },
    message_reference: { message_id: "U9", fail_if_not_exists: false },
    nonce: "n-abc-0",
    enforce_nonce: true,
  });
});

test("text containing a $( substitution is sent verbatim, not refused", async () => {
  const { http, seen } = fakeHttp(() => ok({ id: "M1" }));
  const text = "run `echo $(id)` and $(whoami)";
  await new Discord(http, fakeClock(0), "tok", BASE).send("C1", text);
  expect(JSON.parse(String(seen[0]?.body)).content).toBe(text);
});

test("sendWithFile posts multipart with payload_json and files[0]", async () => {
  const { http, seen } = fakeHttp(() => ok({ id: "M3" }));
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const id = await new Discord(http, fakeClock(0), "tok", BASE).sendWithFile("C1", "look $(id)", { name: "happy.png", bytes, contentType: "image/png" }, { replyToMessageId: "U1", nonce: "n1" });
  expect(id).toBe("M3");
  const req = seen[0]!;
  expect(req.headers?.["Content-Type"]).toBeUndefined();
  expect(req.body).toBeInstanceOf(FormData);
  const form = req.body as FormData;
  expect([...form.keys()]).toEqual(["payload_json", "files[0]"]);
  expect(JSON.parse(String(form.get("payload_json")))).toEqual({
    content: "look $(id)",
    allowed_mentions: { parse: [] },
    message_reference: { message_id: "U1", fail_if_not_exists: false },
    nonce: "n1",
    enforce_nonce: true,
    attachments: [{ id: 0, filename: "happy.png" }],
  });
  const file = form.get("files[0]") as File;
  expect(file.name).toBe("happy.png");
  expect(file.type).toBe("image/png");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
});

test("edit, typing, listMessages, me and gatewayUrl hit the expected routes", async () => {
  const { http, seen } = fakeHttp((req) => {
    if (req.url.endsWith("/users/@me")) return ok({ id: "B1", username: "hent", bot: true });
    if (req.url.endsWith("/gateway/bot")) return ok({ url: "wss://gateway.discord.gg" });
    if (req.method === "GET") return ok([{ id: "M5", channel_id: "C1", author: { id: "U1", username: "v" }, content: "x", timestamp: "t" }]);
    if (req.url.endsWith("/typing")) return { status: 204, headers: {}, body: "" };
    return ok({ id: "M1" });
  });
  const dc = new Discord(http, fakeClock(0), "tok", BASE);
  await dc.edit("C1", "M1", "again");
  await dc.typing("C1");
  expect((await dc.listMessages("C1", { after: "M4", limit: 50 })).map((m) => m.id)).toEqual(["M5"]);
  await dc.listMessages("C1");
  expect(await dc.me()).toEqual({ id: "B1", username: "hent", bot: true });
  expect(await dc.gatewayUrl()).toBe("wss://gateway.discord.gg");
  expect(seen.map((r) => `${r.method} ${path(r.url)}`)).toEqual([
    "PATCH /channels/C1/messages/M1",
    "POST /channels/C1/typing",
    "GET /channels/C1/messages?after=M4&limit=50",
    "GET /channels/C1/messages",
    "GET /users/@me",
    "GET /gateway/bot",
  ]);
  expect(JSON.parse(String(seen[0]?.body))).toEqual({ content: "again", allowed_mentions: { parse: [] } });
  expect(seen[1]?.body).toBeUndefined();
});

test("HTTP 403 surfaces as MessengerError with status 403 and is not retried", async () => {
  const { http, seen } = fakeHttp(() => ok({ message: "Missing Permissions", code: 50013 }, 403));
  const clock = fakeClock(0);
  const err = await new Discord(http, clock, "tok", BASE).send("C1", "hi").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MessengerError);
  expect((err as MessengerError).status).toBe(403);
  expect(seen).toHaveLength(1);
  expect(clock.waited).toEqual([]);
  console.log(`403 case: ${(err as MessengerError).name} status=${(err as MessengerError).status} attempts=${seen.length} message=${(err as MessengerError).message}`);
});

test("persistent 5xx gives up after the retry budget with MessengerError", async () => {
  const { http, seen } = fakeHttp(() => ok({}, 502));
  const clock = fakeClock(0);
  const err = await new Discord(http, clock, "tok", BASE).typing("C1").catch((e: unknown) => e);
  expect((err as MessengerError).status).toBe(502);
  expect(seen).toHaveLength(5);
  expect(clock.waited).toEqual([1000, 2000, 4000, 8000]);
});

test("the API base defaults to Discord and is overridable only via HENT_DISCORD_API_BASE", () => {
  expect(discordApiBase({})).toBe(DISCORD_API_BASE);
  expect(discordApiBase({ HENT_DISCORD_API_BASE: "http://127.0.0.1:18800/api/v10" })).toBe("http://127.0.0.1:18800/api/v10");
});
