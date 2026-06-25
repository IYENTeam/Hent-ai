import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG, type ConversationDecisionProvider } from "./conversation-config.js";
import { createConversationRuntime } from "./conversation-runtime.js";
import { createDiscordPollerIntegration, loadDiscordPollerConfigFromEnv } from "./discord-poller-integration.js";
import {
  RateLimitError,
  chunkMessage,
  createDiscordRestPoller,
  fetchChannelMessages,
  sendChannelMessage,
  type DiscordRestClient,
  type DiscordRestMessage,
} from "./discord-rest-poller.js";
import { ServiceDatabase } from "./db.js";
import { createHentAiServerWithPoller } from "./server-with-poller.js";
import { nullVerifier } from "./service-test-helpers.js";

function apiMessage(input: {
  readonly id: string;
  readonly content: string;
  readonly authorId?: string;
  readonly username?: string;
  readonly bot?: boolean;
}): Record<string, unknown> {
  return {
    id: input.id,
    content: input.content,
    author: {
      id: input.authorId ?? "user-1",
      username: input.username ?? "alice",
      ...(input.bot === undefined ? {} : { bot: input.bot }),
    },
    timestamp: "2026-06-24T00:00:00.000Z",
  };
}

function restMessage(input: {
  readonly id: string;
  readonly content: string;
  readonly authorId?: string;
  readonly bot?: boolean;
}): DiscordRestMessage {
  return {
    id: input.id,
    channelId: "c1",
    content: input.content,
    authorId: input.authorId ?? "user-1",
    authorUsername: input.authorId ?? "alice",
    authorBot: input.bot === true,
    timestamp: "2026-06-24T00:00:00.000Z",
  };
}

describe("Discord REST API boundary", () => {
  it("fetches channel messages chronologically and sends Discord auth headers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      apiMessage({ id: "3", content: "third" }),
      apiMessage({ id: "2", content: "second" }),
      apiMessage({ id: "1", content: "first" }),
    ])));

    const messages = await fetchChannelMessages("bot-token", "c1", { after: "0", limit: 10 }, fetchImpl);

    expect(messages.map((message) => message.id)).toEqual(["1", "2", "3"]);
    expect(messages[0]).toMatchObject({ content: "first", authorId: "user-1", authorBot: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/c1/messages?after=0&limit=10",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bot bot-token" }) }),
    );
  });

  it("surfaces Discord rate limits with retry timing", async () => {
    const fetchImpl = vi.fn(async () => new Response("", {
      status: 429,
      headers: { "Retry-After": "2.5" },
    }));

    await expect(fetchChannelMessages("bot-token", "c1", {}, fetchImpl)).rejects.toEqual(new RateLimitError(2500));
  });

  it("sends messages and chunks long Discord content", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "sent-1" })));

    const sentId = await sendChannelMessage("bot-token", "c1", "hello", fetchImpl);

    expect(sentId).toBe("sent-1");
    expect(chunkMessage(`${"a".repeat(1_500)}\n${"b".repeat(1_500)}`)).toEqual([
      "a".repeat(1_500),
      "b".repeat(1_500),
    ]);
  });
});

describe("Discord REST poller", () => {
  it("uses the first poll as catch-up and processes only later non-empty messages", async () => {
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>()
      .mockResolvedValueOnce([restMessage({ id: "10", content: "old" })])
      .mockResolvedValueOnce([
        restMessage({ id: "11", content: "   " }),
        restMessage({ id: "12", content: "new" }),
      ]);
    const handled: DiscordRestMessage[] = [];
    const poller = createDiscordRestPoller({
      config: { token: "bot-token", channels: ["c1"] },
      client: { fetchMessages, sendMessage: vi.fn<DiscordRestClient["sendMessage"]>() },
      onMessage: (message) => {
        handled.push(message);
      },
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(fetchMessages.mock.calls.map(([, options]) => options.after)).toEqual([undefined, "10"]);
    expect(handled.map((message) => message.id)).toEqual(["12"]);
  });

  it("does not drop the first live message after an empty catch-up poll", async () => {
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([restMessage({ id: "21", content: "first live" })]);
    const handled: DiscordRestMessage[] = [];
    const poller = createDiscordRestPoller({
      config: { token: "bot-token", channels: ["c1"] },
      client: { fetchMessages, sendMessage: vi.fn<DiscordRestClient["sendMessage"]>() },
      onMessage: (message) => {
        handled.push(message);
      },
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(handled.map((message) => message.id)).toEqual(["21"]);
  });

  it("backs off after a Discord rate limit", async () => {
    let nowMs = 1_000;
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>()
      .mockRejectedValueOnce(new RateLimitError(2_000))
      .mockResolvedValueOnce([restMessage({ id: "20", content: "later" })]);
    const poller = createDiscordRestPoller({
      config: { token: "bot-token", channels: ["c1"] },
      client: { fetchMessages, sendMessage: vi.fn<DiscordRestClient["sendMessage"]>() },
      now: () => nowMs,
      onMessage: vi.fn(),
    });
    poller.seedLastSeen("c1", "0");

    await poller.pollOnce();
    await poller.pollOnce();
    nowMs = 3_001;
    await poller.pollOnce();

    expect(fetchMessages).toHaveBeenCalledTimes(2);
  });
});

describe("Discord poller integration", () => {
  it("loads poller config from the service deployment Discord env names", () => {
    const config = loadDiscordPollerConfigFromEnv({
      HENT_AI_DISCORD_TOKEN: "service-discord-token",
      HENT_AI_WATCH_CHANNELS: " c1, c2 ",
      HENT_AI_DISCORD_POLLER_BOT_USER_ID: "bot-1",
      HENT_AI_DISCORD_POLLER_EVALUATION_INTERVAL_MS: "30000",
    });

    expect(config).toEqual({
      token: "service-discord-token",
      channels: ["c1", "c2"],
      botUserId: "bot-1",
      evaluationIntervalMs: 30_000,
      autoStart: true,
    });
  });

  it("prefers explicit poller env names over service deployment fallback names", () => {
    const config = loadDiscordPollerConfigFromEnv({
      HENT_AI_DISCORD_POLLER_TOKEN: "poller-token",
      HENT_AI_DISCORD_POLLER_CHANNELS: "poller-channel",
      HENT_AI_DISCORD_TOKEN: "service-discord-token",
      HENT_AI_WATCH_CHANNELS: "service-channel",
    });

    expect(config).toMatchObject({
      token: "poller-token",
      channels: ["poller-channel"],
    });
  });

  it("records human messages immediately and replies on the periodic chat tick", async () => {
    const db = new ServiceDatabase();
    const runtime = createConversationRuntime(db, {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minDelayMs: 0,
      maxDelayMs: 0,
      maxChunkChars: 1_800,
      minHumanIdleMs: 0,
      cooldownMs: 0,
    }, {
      decisionProvider: {
        decide: vi.fn<ConversationDecisionProvider["decide"]>().mockResolvedValue({
          kind: "speak",
          confidence: 0.95,
          chunks: ["ㅇㅇ 지금 얘기한 방향이면 서비스가 방을 읽고 있다가 필요할 때 답하는 구조가 맞아."],
        }),
      },
    });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "u1", content: "그냥 사람처럼 단톡방에서 보고 있다가 필요한 때 답하면 돼", authorId: "human-1" }),
    ]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>().mockResolvedValue("discord-reply-1");
    const integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage },
      wait: async () => {},
    });
    integration.poller.seedLastSeen("c1", "0");

    await integration.poller.pollOnce();

    expect(sendMessage).not.toHaveBeenCalled();
    await integration.evaluateOnce();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("c1", "ㅇㅇ 지금 얘기한 방향이면 서비스가 방을 읽고 있다가 필요할 때 답하는 구조가 맞아.");
    expect(db.db.prepare("SELECT message_id, author_role FROM conversation_raw_events WHERE scope_id = ? ORDER BY id").all("discord:c1")).toMatchObject([
      { message_id: "u1", author_role: "user" },
      { message_id: "discord-reply-1", author_role: "assistant" },
    ]);
    db.close();
  });

  it("records self bot messages without queuing a new chat reply", async () => {
    const db = new ServiceDatabase();
    const decide = vi.fn<ConversationDecisionProvider["decide"]>().mockResolvedValue({
      kind: "speak",
      confidence: 0.95,
      chunks: ["이 메시지는 보내지면 안 됩니다."],
    });
    const runtime = createConversationRuntime(db, {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minHumanIdleMs: 0,
    }, { decisionProvider: { decide } });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "b1", content: "self bot content", authorId: "bot-1", bot: true }),
    ]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>().mockResolvedValue("discord-reply-1");
    const integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage },
      wait: async () => {},
    });
    integration.poller.seedLastSeen("c1", "0");

    await integration.poller.pollOnce();
    await integration.evaluateOnce();

    expect(decide).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT message_id, author_role FROM conversation_raw_events WHERE scope_id = ? ORDER BY id").all("discord:c1")).toMatchObject([
      { message_id: "b1", author_role: "assistant" },
    ]);
    db.close();
  });

  it("keeps a human-triggered chat reply candidate across no-reply ticks", async () => {
    const db = new ServiceDatabase();
    const decide = vi.fn<ConversationDecisionProvider["decide"]>()
      .mockResolvedValueOnce({ kind: "no_reply", reason: "wait_for_context" })
      .mockResolvedValueOnce({
        kind: "speak",
        confidence: 0.95,
        chunks: ["이제 답해도 되는 타이밍이야."],
      });
    const runtime = createConversationRuntime(db, {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minHumanIdleMs: 0,
      cooldownMs: 0,
    }, { decisionProvider: { decide } });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "u1", content: "이거 어떻게 볼까?", authorId: "human-1" }),
    ]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>().mockResolvedValue("discord-reply-1");
    const integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage },
      wait: async () => {},
    });
    integration.poller.seedLastSeen("c1", "0");

    await integration.poller.pollOnce();
    await integration.evaluateOnce();
    await integration.evaluateOnce();

    expect(decide).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith("c1", "이제 답해도 되는 타이밍이야.");
    db.close();
  });

  it("exposes service server wiring with an optional Discord poller", async () => {
    const db = new ServiceDatabase();
    const result = createHentAiServerWithPoller({
      db,
      token: "service-token",
      verifier: nullVerifier,
      conversationConfig: { ...DEFAULT_CONVERSATION_CONFIG, enabled: true },
      discordPollerConfig: { token: "bot-token", channels: ["c1"], autoStart: false },
      discordPollerClient: {
        fetchMessages: vi.fn<DiscordRestClient["fetchMessages"]>(),
        sendMessage: vi.fn<DiscordRestClient["sendMessage"]>(),
      },
    });

    expect(result.startPoller).toBeDefined();
    expect(result.stopPoller).toBeDefined();
    await result.stopPoller?.();
    db.close();
  });
});
