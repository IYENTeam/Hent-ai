import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDiscordRestPoller,
  fetchChannelMessages,
  sendChannelMessage,
  chunkMessage,
  RateLimitError,
  type DiscordRestMessage,
} from "./discord-rest-poller.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeDiscordApiMessage(overrides: Partial<{ id: string; content: string; author: { id: string; username: string; bot?: boolean }; timestamp: string }> = {}) {
  return {
    id: overrides.id ?? "1001",
    content: overrides.content ?? "hello",
    author: overrides.author ?? { id: "user1", username: "testuser", bot: false },
    timestamp: overrides.timestamp ?? "2026-06-23T00:00:00Z",
  };
}

describe("fetchChannelMessages", () => {
  beforeEach(() => mockFetch.mockReset());

  it("fetches and reverses messages to chronological order", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeDiscordApiMessage({ id: "3", content: "third" }),
        makeDiscordApiMessage({ id: "2", content: "second" }),
        makeDiscordApiMessage({ id: "1", content: "first" }),
      ],
    });

    const messages = await fetchChannelMessages("token", "ch1", { limit: 50 });
    expect(messages).toHaveLength(3);
    expect(messages[0].id).toBe("1");
    expect(messages[0].content).toBe("first");
    expect(messages[2].id).toBe("3");
  });

  it("passes after parameter", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await fetchChannelMessages("token", "ch1", { after: "999", limit: 10 });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("after=999");
    expect(url).toContain("limit=10");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
      headers: new Map(),
    });
    await expect(fetchChannelMessages("token", "ch1", {})).rejects.toThrow("Discord API 403");
  });

  it("throws RateLimitError on 429", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (k: string) => k === "Retry-After" ? "2.5" : null },
    });
    await expect(fetchChannelMessages("token", "ch1", {})).rejects.toBeInstanceOf(RateLimitError);
    try {
      await fetchChannelMessages("token", "ch1", {});
    } catch (e) {
      // already thrown above
    }
  });
});

describe("chunkMessage", () => {
  it("returns single chunk for short text", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("splits at newline boundary", () => {
    const text = "a".repeat(1500) + "\n" + "b".repeat(1500);
    const chunks = chunkMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(1500));
    expect(chunks[1]).toBe("b".repeat(1500));
  });

  it("hard-splits when no newline found", () => {
    const text = "x".repeat(4000);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every(c => c.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("sendChannelMessage", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends message and returns id", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "sent-1" }),
    });
    const id = await sendChannelMessage("token", "ch1", "hello!");
    expect(id).toBe("sent-1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/channels/ch1/messages"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });
    await expect(sendChannelMessage("token", "ch1", "hi")).rejects.toThrow("Discord send 400");
  });
});

describe("createDiscordRestPoller", () => {
  beforeEach(() => mockFetch.mockReset());

  it("polls channels and calls handleMessage for user messages", async () => {
    const userMsg = makeDiscordApiMessage({ id: "100", content: "hey", author: { id: "u1", username: "alice" } });
    const botMsg = makeDiscordApiMessage({ id: "101", content: "bot reply", author: { id: "bot1", username: "bot", bot: true } });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [botMsg, userMsg],
    });

    const handleMessage = vi.fn().mockResolvedValue({ speak: false });
    const onMessages = vi.fn();

    const poller = createDiscordRestPoller({
      config: { token: "tok", channels: ["ch1"], intervalMs: 60000 },
      callbacks: { onMessages },
      handleMessage,
    });

    // Seed to skip catch-up behavior
    poller.seedLastSeen("ch1", "0");
    poller.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith("ch1", expect.objectContaining({ id: "100", content: "hey" }));
    expect(handleMessage).not.toHaveBeenCalledWith("ch1", expect.objectContaining({ authorBot: true }));

    await poller.stop();
  });

  it("sends message when handleMessage returns speak: true", async () => {
    const userMsg = makeDiscordApiMessage({ id: "200", content: "question?" });

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [userMsg] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "sent-200" }) });

    const handleMessage = vi.fn().mockResolvedValue({ speak: true, text: "answer!" });
    const onSpeak = vi.fn();

    const poller = createDiscordRestPoller({
      config: { token: "tok", channels: ["ch1"], intervalMs: 60000 },
      callbacks: { onSpeak },
      handleMessage,
    });

    poller.seedLastSeen("ch1", "0");
    poller.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(onSpeak).toHaveBeenCalledWith("ch1", "answer!", "sent-200");
    await poller.stop();
  });

  it("skips own bot messages by botUserId", async () => {
    const ownMsg = makeDiscordApiMessage({ id: "300", content: "my msg", author: { id: "mybot", username: "IYEN" } });

    mockFetch.mockResolvedValue({ ok: true, json: async () => [ownMsg] });

    const handleMessage = vi.fn().mockResolvedValue({ speak: false });

    const poller = createDiscordRestPoller({
      config: { token: "tok", channels: ["ch1"], intervalMs: 60000, botUserId: "mybot" },
      callbacks: {},
      handleMessage,
    });

    poller.seedLastSeen("ch1", "0");
    poller.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(handleMessage).not.toHaveBeenCalled();
    await poller.stop();
  });

  it("seedLastSeen prevents processing old messages", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });

    const poller = createDiscordRestPoller({
      config: { token: "tok", channels: ["ch1"], intervalMs: 60000 },
      callbacks: {},
      handleMessage: vi.fn().mockResolvedValue({ speak: false }),
    });

    poller.seedLastSeen("ch1", "500");
    poller.start();
    await new Promise((r) => setTimeout(r, 50));

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("after=500");
    await poller.stop();
  });

  it("first poll without seedLastSeen only sets marker, does not process", async () => {
    const msgs = [
      makeDiscordApiMessage({ id: "10", content: "old msg", author: { id: "u1", username: "alice" } }),
      makeDiscordApiMessage({ id: "20", content: "newer msg", author: { id: "u2", username: "bob" } }),
    ];
    mockFetch.mockResolvedValue({ ok: true, json: async () => msgs });

    const handleMessage = vi.fn().mockResolvedValue({ speak: false });

    const poller = createDiscordRestPoller({
      config: { token: "tok", channels: ["ch1"], intervalMs: 60000 },
      callbacks: {},
      handleMessage,
    });

    poller.start();
    await new Promise((r) => setTimeout(r, 50));

    // First poll is catch-up: should NOT call handleMessage
    expect(handleMessage).not.toHaveBeenCalled();
    await poller.stop();
  });

  it("stop() waits for in-flight poll", async () => {
    let resolveMsg: (() => void) | null = null;
    const msgPromise = new Promise<void>((r) => { resolveMsg = r; });

    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });

    const handleMessage = vi.fn().mockImplementation(async () => {
      await msgPromise;
      return { speak: false };
    });

    const poller = createDiscordRestPoller({
      config: { token: "tok", channels: ["ch1"], intervalMs: 60000 },
      callbacks: {},
      handleMessage,
    });

    // Seed to skip catch-up
    poller.seedLastSeen("ch1", "0");
    poller.start();
    await new Promise((r) => setTimeout(r, 20));

    const stopPromise = poller.stop();
    resolveMsg!();
    // stop() should resolve without hanging
    await stopPromise;
  });
});
