import { describe, expect, test } from "bun:test";
import {
  MAX_INBOX_EVENTS,
  advanceCursor,
  chunkNonce,
  isBaseNonce,
  parseEditRequest,
  parseHandledRequest,
  parseHealthResponse,
  parseHistoryQuery,
  parseHistoryResponse,
  parseInboxEvent,
  parseInboxQuery,
  parseInboxResponse,
  parseSendMultipart,
  parseSendRequest,
  parseSendResponse,
  parseSessionRequest,
  parseTypingRequest,
  TYPING_INTERVAL_MS,
  typingTicks,
  type InboxEvent,
} from "../src/bridge/contract";

const q = (s: string) => new URLSearchParams(s);

function event(seq: number, over: Partial<InboxEvent> = {}): InboxEvent {
  return {
    seq,
    kind: "message_create",
    channelId: "1486627737568546979",
    guildId: "1483095221460799489",
    messageId: `14866277375685${String(seq).padStart(5, "0")}`,
    authorId: "1000000000000000001",
    authorIsBot: false,
    authorIsSelf: false,
    authorName: "victor",
    content: "hello $(id) \"quoted\"\nline",
    referencedMessageId: null,
    attachments: [{ url: "https://cdn.discordapp.com/a.png", contentType: "image/png", name: "a.png" }],
    createdAt: "2026-10-13T07:00:00.000Z",
    ...over,
  };
}

function expectErr(r: { ok: boolean; error?: string }, pattern: RegExp) {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(pattern);
}

describe("advanceCursor", () => {
  test("advances to a higher ack", () => {
    expect(advanceCursor(5, 9)).toBe(9);
  });
  test("lower-seq ack is ignored and leaves the cursor unchanged", () => {
    expect(advanceCursor(10, 3)).toBe(10);
    expect(advanceCursor(10, 10)).toBe(10);
    expect(advanceCursor(10, 0, 50)).toBe(10);
  });
  test("absent ack leaves the cursor unchanged", () => {
    expect(advanceCursor(7, null)).toBe(7);
    expect(advanceCursor(7, undefined)).toBe(7);
  });
  test("ack past lastSeq is clamped, never moving backwards", () => {
    expect(advanceCursor(5, 100, 20)).toBe(20);
    expect(advanceCursor(30, 100, 20)).toBe(30);
  });
  test("is monotonic across any ack sequence", () => {
    let cursor = 0;
    for (const ack of [4, 2, 8, 8, 1, 15, 0, 15, 16]) {
      const next = advanceCursor(cursor, ack);
      expect(next).toBeGreaterThanOrEqual(cursor);
      cursor = next;
    }
    expect(cursor).toBe(16);
  });
});

describe("inbox query", () => {
  test("valid with defaults", () => {
    expect(parseInboxQuery(q("consumer=brain"))).toEqual({
      ok: true,
      value: { consumer: "brain", wait: 0, ack: null, takeover: false },
    });
  });
  test("valid with wait=25, ack and takeover", () => {
    expect(parseInboxQuery(q("consumer=qa-1&wait=25&ack=42&takeover=1"))).toEqual({
      ok: true,
      value: { consumer: "qa-1", wait: 25, ack: 42, takeover: true },
    });
  });
  test("wait > 25 is rejected", () => {
    expectErr(parseInboxQuery(q("consumer=brain&wait=26")), /wait must be <= 25/);
  });
  test("malformed queries are rejected", () => {
    expectErr(parseInboxQuery(q("wait=1")), /consumer/);
    expectErr(parseInboxQuery(q("consumer=../etc")), /consumer/);
    expectErr(parseInboxQuery(q("consumer=a&wait=-1")), /wait/);
    expectErr(parseInboxQuery(q("consumer=a&wait=1.5")), /wait/);
    expectErr(parseInboxQuery(q("consumer=a&ack=abc")), /ack/);
    expectErr(parseInboxQuery(q("consumer=a&takeover=yes")), /takeover/);
    expectErr(parseInboxQuery(q("consumer=a&ack=1&ack=2")), /duplicate/);
    expectErr(parseInboxQuery(q("consumer=a&limit=5")), /unknown parameter/);
  });
});

describe("history query", () => {
  test("valid with default and max limit", () => {
    expect(parseHistoryQuery(q("channelId=e2e-room"))).toEqual({ ok: true, value: { channelId: "e2e-room", limit: 50 } });
    expect(parseHistoryQuery(q("channelId=1486627737568546979&limit=100"))).toEqual({
      ok: true,
      value: { channelId: "1486627737568546979", limit: 100 },
    });
  });
  test("limit overflow and zero are rejected", () => {
    expectErr(parseHistoryQuery(q("channelId=c&limit=101")), /limit must be between 1 and 100/);
    expectErr(parseHistoryQuery(q("channelId=c&limit=0")), /limit/);
  });
  test("malformed channelId is rejected", () => {
    expectErr(parseHistoryQuery(q("limit=5")), /channelId/);
    expectErr(parseHistoryQuery(q("channelId=a/b")), /channelId/);
  });
});

describe("nonces", () => {
  test("base nonce is at most 22 chars, chunk nonce at most 25", () => {
    const base = "a".repeat(22);
    expect(isBaseNonce(base)).toBe(true);
    expect(isBaseNonce("a".repeat(23))).toBe(false);
    expect(isBaseNonce("has-dash")).toBe(false);
    expect(chunkNonce(base, 0)).toBe(`${base}-0`);
    expect(chunkNonce(base, 99)).toHaveLength(25);
    expect(() => chunkNonce(base, 100)).toThrow(/exceeds 25/);
    expect(() => chunkNonce("a".repeat(23), 0)).toThrow(/invalid base nonce/);
  });
});

describe("send request (JSON)", () => {
  const valid = { channelId: "1486627737568546979", text: "done $(id)", nonce: "n1a2b3" };
  test("valid without and with replyTo / chunk nonce", () => {
    expect(parseSendRequest(valid)).toEqual({ ok: true, value: { ...valid, replyToMessageId: null } });
    const r = parseSendRequest({ ...valid, replyToMessageId: "1486627737568540001", nonce: chunkNonce("a".repeat(22), 12) });
    expect(r.ok).toBe(true);
  });
  test("nonce too long is rejected", () => {
    expectErr(parseSendRequest({ ...valid, nonce: "a".repeat(23) }), /nonce/);
    expectErr(parseSendRequest({ ...valid, nonce: `${"a".repeat(22)}-100` }), /nonce/);
    expectErr(parseSendRequest({ ...valid, nonce: "" }), /nonce/);
  });
  test("malformed bodies are rejected", () => {
    expectErr(parseSendRequest(null), /JSON object/);
    expectErr(parseSendRequest([valid]), /JSON object/);
    expectErr(parseSendRequest({ ...valid, text: "" }), /text must not be empty/);
    expectErr(parseSendRequest({ ...valid, text: "x".repeat(2001) }), /2000/);
    expectErr(parseSendRequest({ ...valid, channelId: 123 }), /channelId/);
    expectErr(parseSendRequest({ ...valid, replyTo: "1" }), /unknown field "replyTo"/);
    const { nonce: _omit, ...noNonce } = valid;
    expectErr(parseSendRequest(noNonce), /nonce/);
  });
});

describe("send request (multipart)", () => {
  function form(payload: unknown, file: File | null = new File([new Uint8Array([1, 2, 3])], "happy.png", { type: "image/png" })) {
    const f = new FormData();
    f.set("payload", typeof payload === "string" ? payload : JSON.stringify(payload));
    if (file) f.set("file", file);
    return f;
  }
  test("valid payload + file, empty text allowed", () => {
    const r = parseSendMultipart(form({ channelId: "c1", text: "", nonce: "abc" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.file.name).toBe("happy.png");
      expect(r.value.file.contentType).toBe("image/png");
      expect(r.value.text).toBe("");
    }
  });
  test("malformed multipart is rejected", () => {
    expectErr(parseSendMultipart(form("{not json")), /not valid JSON/);
    expectErr(parseSendMultipart(form({ channelId: "c1", text: "", nonce: "abc" }, null)), /file/);
    expectErr(parseSendMultipart(form({ channelId: "c1", text: "", nonce: "a".repeat(26) })), /nonce/);
    const extra = form({ channelId: "c1", text: "", nonce: "abc" });
    extra.set("other", "x");
    expectErr(parseSendMultipart(extra), /unknown field "other"/);
    const empty = form({ channelId: "c1", text: "", nonce: "abc" }, new File([], "e.png"));
    expectErr(parseSendMultipart(empty), /empty/);
  });
});

describe("edit / typing / handled / session", () => {
  test("edit", () => {
    expect(parseEditRequest({ channelId: "c1", messageId: "m1", text: "fixed" }).ok).toBe(true);
    expectErr(parseEditRequest({ channelId: "c1", text: "fixed" }), /messageId/);
  });
  test("typing", () => {
    expect(parseTypingRequest({ channelId: "c1" })).toEqual({ ok: true, value: { channelId: "c1", forSeconds: null } });
    expect(parseTypingRequest({ channelId: "c1", forSeconds: 150 })).toEqual({ ok: true, value: { channelId: "c1", forSeconds: 150 } });
    expect(parseTypingRequest({ channelId: "c1", forSeconds: null })).toEqual({ ok: true, value: { channelId: "c1", forSeconds: null } });
    expectErr(parseTypingRequest({}), /channelId/);
    expectErr(parseTypingRequest({ channelId: "c1", forSeconds: 0 }), /forSeconds/);
    expectErr(parseTypingRequest({ channelId: "c1", forSeconds: 1.5 }), /forSeconds/);
    expectErr(parseTypingRequest({ channelId: "c1", forSeconds: 601 }), /forSeconds must be <= 600/);
    expectErr(parseTypingRequest({ channelId: "c1", forSeconds: "20" }), /forSeconds/);
    expectErr(parseTypingRequest({ channelId: "c1", hold: 20 }), /unknown field "hold"/);
  });

  test("a held typing window re-sends on every interval tick that is still inside it", () => {
    expect(TYPING_INTERVAL_MS).toBe(8_000);
    // --for 20: typing at 0 s, 8 s and 16 s -> two re-sends after the immediate one.
    expect(typingTicks(20)).toBe(2);
    expect(typingTicks(8)).toBe(0);
    expect(typingTicks(16)).toBe(1);
    expect(typingTicks(150)).toBe(18);
    expect(typingTicks(1)).toBe(0);
    expect(typingTicks(1, 20)).toBe(49);
  });
  test("handled", () => {
    expect(parseHandledRequest({ messageId: "m1", how: "skipped" })).toEqual({ ok: true, value: { messageId: "m1", how: "skipped" } });
    expect(parseHandledRequest({ messageId: "m1", how: "replied" }).ok).toBe(true);
    expectErr(parseHandledRequest({ messageId: "m1", how: "ignored" }), /replied\|skipped/);
  });
  test("session", () => {
    expect(parseSessionRequest({ agent: "codex", sessionId: "3f2a-uuid", pane: "w1:p3", cwd: "/Users/iyen/work" })).toEqual({
      ok: true,
      value: { agent: "codex", sessionId: "3f2a-uuid", pane: "w1:p3", cwd: "/Users/iyen/work" },
    });
    expect(parseSessionRequest({ agent: "codex", sessionId: "s1", pane: "wD:p12", cwd: "/tmp" }).ok).toBe(true);
    expectErr(parseSessionRequest({ agent: "gpt", sessionId: "s1", pane: "w1:p3", cwd: "/tmp" }), /agent/);
    // The brain is Codex only; the removed Claude agent is no longer accepted.
    expectErr(parseSessionRequest({ agent: "claude", sessionId: "s1", pane: "w1:p3", cwd: "/tmp" }), /agent must be one of codex/);
    expectErr(parseSessionRequest({ agent: "codex", sessionId: "s1", cwd: "/tmp" }), /pane/);
    expectErr(parseSessionRequest({ agent: "codex", sessionId: "s1", pane: "%0", cwd: "/tmp" }), /herdr pane id/);
    expectErr(parseSessionRequest({ agent: "codex", sessionId: "s1", pane: "w1:p3", mode: "headless", cwd: "/tmp" }), /mode/);
    expectErr(parseSessionRequest({ agent: "codex", sessionId: "s1", pane: "w1:p3", cwd: "relative" }), /absolute/);
    expectErr(parseSessionRequest({ agent: "codex", sessionId: "s 1", pane: "w1:p3", cwd: "/tmp" }), /sessionId/);
  });

});

describe("inbox event and responses", () => {
  test("valid event round-trips, content verbatim", () => {
    const e = event(1);
    expect(parseInboxEvent(JSON.parse(JSON.stringify(e)))).toEqual({ ok: true, value: e });
  });
  test("malformed events are rejected", () => {
    expectErr(parseInboxEvent({ ...event(1), kind: "reaction_add" }), /kind/);
    expectErr(parseInboxEvent({ ...event(0) }), /seq/);
    const { guildId: _g, ...noGuild } = event(1);
    expectErr(parseInboxEvent(noGuild), /guildId/);
    expectErr(parseInboxEvent({ ...event(1), createdAt: "yesterday" }), /createdAt/);
    expectErr(parseInboxEvent({ ...event(1), attachments: [{ url: "file:///etc/passwd", contentType: null, name: "x" }] }), /url/);
  });
  test("inbox response: ordered, after cursor, at most 100 events", () => {
    expect(parseInboxResponse({ events: [event(4), event(5)], cursor: 3 }).ok).toBe(true);
    expectErr(parseInboxResponse({ events: [event(5), event(4)], cursor: 3 }), /increasing seq/);
    expectErr(parseInboxResponse({ events: [event(3)], cursor: 3 }), /after the cursor/);
    const tooMany = Array.from({ length: MAX_INBOX_EVENTS + 1 }, (_, i) => event(i + 1));
    expectErr(parseInboxResponse({ events: tooMany, cursor: 0 }), /exceeds 100/);
  });
  test("history response limit overflow is rejected", () => {
    expect(parseHistoryResponse({ events: [event(1)] }).ok).toBe(true);
    const tooMany = Array.from({ length: 101 }, (_, i) => event(i + 1));
    expectErr(parseHistoryResponse({ events: tooMany }), /exceeds 100/);
  });
  test("send response", () => {
    expect(parseSendResponse({ messageId: "1486627737568546001", extra: true })).toEqual({
      ok: true,
      value: { messageId: "1486627737568546001" },
    });
    expectErr(parseSendResponse({}), /messageId/);
  });
  test("health", () => {
    const h = {
      gateway: "connected",
      botUserId: "1480000000000000000",
      lastSeq: 12,
      consumers: [{ name: "qa", cursor: 10, leaseExpiresAt: "2026-10-13T07:01:00.000Z" }],
    };
    expect(parseHealthResponse(h)).toEqual({ ok: true, value: h as never });
    expect(parseHealthResponse({ gateway: "reconnecting", botUserId: null, lastSeq: 0, consumers: [] }).ok).toBe(true);
    expectErr(parseHealthResponse({ ...h, gateway: "down" }), /gateway/);
    expectErr(parseHealthResponse({ ...h, lastSeq: -1 }), /lastSeq/);
  });
});
