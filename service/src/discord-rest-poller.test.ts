import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONVERSATION_CONFIG, type ConversationDecisionProvider } from "./conversation-config.js";
import { createConversationRuntime } from "./conversation-runtime.js";
import { createDiscordPollerIntegration, loadDiscordPollerConfigFromEnv } from "./discord-poller-integration.js";
import {
  DiscordHttpError,
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
  readonly channelId?: string;
  readonly authorId?: string;
  readonly bot?: boolean;
}): DiscordRestMessage {
  return {
    id: input.id,
    channelId: input.channelId ?? "c1",
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

  it("uses persisted last-seen state instead of seed-skipping after restart", async () => {
    // Given: poller state already knows the last processed message before startup.
    const handled: DiscordRestMessage[] = [];
    const state = new Map([["c1", "10"]]);
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "11", content: "downtime message" }),
    ]);
    const poller = createDiscordRestPoller({
      config: { token: "bot-token", channels: ["c1"] },
      client: { fetchMessages, sendMessage: vi.fn<DiscordRestClient["sendMessage"]>() },
      stateStore: {
        getLastSeenMessageId: (channelId) => state.get(channelId) ?? null,
        setLastSeenMessageId: (channelId, messageId) => {
          state.set(channelId, messageId);
        },
      },
      onMessage: (message) => {
        handled.push(message);
      },
    });

    // When: the first poll runs after restart.
    await poller.pollOnce();

    // Then: it processes messages after the persisted ID and saves the new watermark.
    expect(fetchMessages).toHaveBeenCalledWith("c1", { after: "10", limit: 50 });
    expect(handled.map((message) => message.id)).toEqual(["11"]);
    expect(state.get("c1")).toBe("11");
  });

  it("logs a Message Content intent diagnostic after consecutive empty human messages", async () => {
    // Given: Discord returns human messages with blank content on repeated ticks.
    const logs: Array<{ readonly level: string; readonly message: string }> = [];
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>()
      .mockResolvedValueOnce([restMessage({ id: "1", content: "" })])
      .mockResolvedValueOnce([restMessage({ id: "2", content: "" })])
      .mockResolvedValueOnce([restMessage({ id: "3", content: "" })]);
    const poller = createDiscordRestPoller({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1" },
      client: { fetchMessages, sendMessage: vi.fn<DiscordRestClient["sendMessage"]>() },
      callbacks: {
        log: (level, message) => logs.push({ level, message }),
      },
      onMessage: vi.fn(),
    });
    poller.seedLastSeen("c1", "0");

    // When: three consecutive polls see only blank human content.
    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();

    // Then: the operator sees the Discord Message Content intent warning.
    expect(logs).toContainEqual({
      level: "error",
      message: "discord-rest-poller: channel=c1 received empty human message content for 3 consecutive polls; enable Discord Message Content Intent",
    });
  });
});

describe("Discord poller integration", () => {
  it("loads poller config from the canonical poller env names", () => {
    const config = loadDiscordPollerConfigFromEnv({
      HENT_AI_DISCORD_POLLER_TOKEN: "poller-token",
      HENT_AI_DISCORD_POLLER_CHANNELS: " c1, c2 ",
      HENT_AI_DISCORD_POLLER_BOT_USER_ID: "bot-1",
      HENT_AI_DISCORD_POLLER_EVALUATION_INTERVAL_MS: "30000",
    });

    expect(config).toEqual({
      token: "poller-token",
      channels: ["c1", "c2"],
      botUserId: "bot-1",
      evaluationIntervalMs: 30_000,
      autoStart: true,
    });
  });

  it("does not enable the poller from removed watcher compatibility env names", () => {
    const config = loadDiscordPollerConfigFromEnv({
      HENT_AI_DISCORD_TOKEN: "service-discord-token",
      HENT_AI_WATCH_CHANNELS: "service-channel",
    });

    expect(config).toBeNull();
  });

  it("allows the generic Discord bot token only when canonical poller channels are configured", () => {
    const config = loadDiscordPollerConfigFromEnv({
      DISCORD_BOT_TOKEN: "bot-token",
      HENT_AI_DISCORD_POLLER_CHANNELS: "poller-channel",
    });

    expect(config).toMatchObject({ token: "bot-token", channels: ["poller-channel"] });
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

  it("triggers typing and waits by chunk length before sending each chat bubble", async () => {
    // Given: a human message produces two reply chunks of different lengths.
    const db = new ServiceDatabase();
    const runtime = createConversationRuntime(db, {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minDelayMs: 0,
      maxDelayMs: 10_000,
      maxChunkChars: 140,
      minHumanIdleMs: 0,
      cooldownMs: 0,
      basePauseMs: 100,
      perCharMs: 10,
    }, {
      decisionProvider: {
        decide: vi.fn<ConversationDecisionProvider["decide"]>().mockResolvedValue({
          kind: "speak",
          confidence: 0.95,
          chunks: ["짧게", "조금 더 긴 두 번째 말풍선"],
        }),
      },
    });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "u1", content: "답해줘", authorId: "human-1" }),
    ]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>()
      .mockResolvedValueOnce("discord-reply-1")
      .mockResolvedValueOnce("discord-reply-2");
    const triggerTyping = vi.fn<NonNullable<DiscordRestClient["triggerTyping"]>>().mockResolvedValue(undefined);
    const waited: number[] = [];
    const integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage, triggerTyping },
      wait: async (ms) => {
        waited.push(ms);
      },
      random: () => 0.42857142857142855,
    });
    integration.poller.seedLastSeen("c1", "0");

    // When: the periodic chat tick delivers the reply.
    await integration.poller.pollOnce();
    await integration.evaluateOnce();

    // Then: typing appears before each chunk and the longer chunk waits longer.
    expect(triggerTyping).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual(["짧게", "조금 더 긴 두 번째 말풍선"]);
    expect(waited).toHaveLength(2);
    expect(waited[1]).toBeGreaterThan(waited[0] ?? 0);
    db.close();
  });

  it("aborts remaining chunks when a newer human message arrives during delivery delay", async () => {
    // Given: an in-flight multi-chunk reply and a newer human message during the second delay.
    const db = new ServiceDatabase();
    const decide = vi.fn<ConversationDecisionProvider["decide"]>()
      .mockResolvedValueOnce({
        kind: "speak",
        confidence: 0.95,
        chunks: ["첫 답장", "뒷북이 될 답장"],
      })
      .mockResolvedValueOnce({
        kind: "speak",
        confidence: 0.95,
        chunks: ["새 메시지 기준으로 다시 답장"],
      });
    const runtime = createConversationRuntime(db, {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minDelayMs: 0,
      maxDelayMs: 10_000,
      maxChunkChars: 140,
      minHumanIdleMs: 0,
      cooldownMs: 0,
      basePauseMs: 100,
      perCharMs: 10,
    }, { decisionProvider: { decide } });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>()
      .mockResolvedValueOnce([restMessage({ id: "u1", content: "처음 질문", authorId: "human-1" })])
      .mockResolvedValueOnce([restMessage({ id: "u2", content: "잠깐, 조건이 바뀌었어", authorId: "human-1" })]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>()
      .mockResolvedValueOnce("discord-reply-1")
      .mockResolvedValueOnce("discord-reply-2");
    const triggerTyping = vi.fn<NonNullable<DiscordRestClient["triggerTyping"]>>().mockResolvedValue(undefined);
    let waitCount = 0;
    let integration: ReturnType<typeof createDiscordPollerIntegration>;
    integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage, triggerTyping },
      wait: async () => {
        waitCount += 1;
        if (waitCount === 2) await integration.poller.pollOnce();
      },
      random: () => 0.42857142857142855,
    });
    integration.poller.seedLastSeen("c1", "0");

    // When: the first delivery is interrupted and the next tick evaluates the newer message.
    await integration.poller.pollOnce();
    await integration.evaluateOnce();
    await integration.evaluateOnce();

    // Then: stale remaining chunks are not sent, and the newer pending message remains eligible.
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual(["첫 답장", "새 메시지 기준으로 다시 답장"]);
    expect(decide).toHaveBeenCalledTimes(2);
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

  it("keeps pending reply state and retries once after a send rate limit", async () => {
    // Given: Discord rate-limits the first delivery attempt.
    const db = new ServiceDatabase();
    const decide = vi.fn<ConversationDecisionProvider["decide"]>().mockResolvedValue({
      kind: "speak",
      confidence: 0.95,
      chunks: ["재시도해서 보내야 해."],
    });
    const runtime = createConversationRuntime(db, {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minHumanIdleMs: 0,
      cooldownMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
    }, { decisionProvider: { decide } });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "u1", content: "보내줘", authorId: "human-1" }),
    ]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>()
      .mockRejectedValueOnce(new RateLimitError(25))
      .mockResolvedValueOnce("discord-reply-1");
    const waited: number[] = [];
    const integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage },
      wait: async (ms) => {
        waited.push(ms);
      },
    });
    integration.poller.seedLastSeen("c1", "0");

    // When: the reply check hits the rate limit.
    await integration.poller.pollOnce();
    await integration.evaluateOnce();

    // Then: delivery retries once, waits for Retry-After, and commits the assistant turn.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(waited).toContain(25);
    expect(db.db.prepare("SELECT message_id, author_role FROM conversation_raw_events WHERE scope_id = ? ORDER BY id").all("discord:c1")).toMatchObject([
      { message_id: "u1", author_role: "user" },
      { message_id: "discord-reply-1", author_role: "assistant" },
    ]);
    db.close();
  });

  it("drops a failed pending reply only after max delivery attempts", async () => {
    // Given: Discord accepts intake but repeatedly rejects sends for one pending reply.
    const logs: Array<{ readonly level: string; readonly message: string }> = [];
    const db = new ServiceDatabase();
    const decide = vi.fn<ConversationDecisionProvider["decide"]>().mockResolvedValue({
      kind: "speak",
      confidence: 0.95,
      chunks: ["권한 문제가 있으면 몇 번만 시도하고 멈춰야 해."],
    });
    const conversationConfig = {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minHumanIdleMs: 0,
      cooldownMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
      maxDeliveryAttempts: 2,
    };
    const runtime = createConversationRuntime(db, conversationConfig, { decisionProvider: { decide } });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "u1", content: "보내줘", authorId: "human-1" }),
    ]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>().mockRejectedValue(new Error("Discord send 403: missing access"));
    const integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage },
      conversationConfig,
      wait: async () => {},
      log: (level, message) => logs.push({ level, message }),
    });
    integration.poller.seedLastSeen("c1", "0");

    // When: the reply check reaches the configured failed-attempt limit.
    await integration.poller.pollOnce();
    await integration.evaluateOnce();
    await integration.evaluateOnce();
    await integration.evaluateOnce();

    // Then: the pending entry is dropped after the second failure and no third send occurs.
    expect(decide).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(logs).toContainEqual({
      level: "error",
      message: "discord-poller-integration: dropping failed chat reply channel=c1 attempts=2",
    });
    db.close();
  });

  it("discards a pending reply immediately after a forbidden Discord send", async () => {
    // Given: Discord reports a channel permissions problem on send.
    const logs: Array<{ readonly level: string; readonly message: string }> = [];
    const db = new ServiceDatabase();
    const decide = vi.fn<ConversationDecisionProvider["decide"]>().mockResolvedValue({
      kind: "speak",
      confidence: 0.95,
      chunks: ["권한 없으면 바로 멈춰야 해."],
    });
    const conversationConfig = {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minHumanIdleMs: 0,
      cooldownMs: 0,
      minDelayMs: 0,
      maxDelayMs: 0,
      maxDeliveryAttempts: 3,
    };
    const runtime = createConversationRuntime(db, conversationConfig, { decisionProvider: { decide } });
    const fetchMessages = vi.fn<DiscordRestClient["fetchMessages"]>().mockResolvedValueOnce([
      restMessage({ id: "u1", content: "보내줘", authorId: "human-1" }),
    ]);
    const sendMessage = vi.fn<DiscordRestClient["sendMessage"]>()
      .mockRejectedValue(new DiscordHttpError("Discord send", 403, "missing access"));
    const integration = createDiscordPollerIntegration({
      config: { token: "bot-token", channels: ["c1"], botUserId: "bot-1", autoStart: false },
      runtime,
      client: { fetchMessages, sendMessage },
      conversationConfig,
      wait: async () => {},
      log: (level, message) => logs.push({ level, message }),
    });
    integration.poller.seedLastSeen("c1", "0");

    // When: the reply check hits the forbidden send.
    await integration.poller.pollOnce();
    await integration.evaluateOnce();
    await integration.evaluateOnce();

    // Then: the permissions failure drops the pending reply without repeated sends.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual({
      level: "error",
      message: "discord-poller-integration: discarding chat reply channel=c1 status=403",
    });
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
