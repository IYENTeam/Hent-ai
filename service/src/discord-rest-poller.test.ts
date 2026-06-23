import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDiscordRestPoller,
  fetchChannelMessages,
  sendChannelMessage,
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
    });
    await expect(fetchChannelMessages("token", "ch1", {})).rejects.toThrow("Discord API 403");
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

    poller.start();
    // Wait for the initial poll to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith("ch1", expect.objectContaining({ id: "100", content: "hey" }));
    expect(handleMessage).not.toHaveBeenCalledWith("ch1", expect.objectContaining({ authorBot: true }));

    poller.stop();
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

    poller.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(onSpeak).toHaveBeenCalledWith("ch1", "answer!", "sent-200");
    poller.stop();
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

    poller.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(handleMessage).not.toHaveBeenCalled();
    poller.stop();
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
    poller.stop();
  });
});
