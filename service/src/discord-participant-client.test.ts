import { describe, expect, it, vi } from "vitest";
import * as service from "./index.js";

type ParticipantClientNamespace = {
  readonly createDiscordParticipantClient?: unknown;
};

type ParticipantClientFactory = (options: {
  readonly token: string;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly apiBaseUrl?: string;
}) => {
  readonly getCurrentUser: (signal?: AbortSignal) => Promise<{ readonly id: string }>;
  readonly verifyChannelGuild: (channelId: string, guildId: string, signal?: AbortSignal) => Promise<{ readonly id: string; readonly guildId: string }>;
  readonly fetchMessages: (channelId: string, page: { readonly after?: string; readonly limit?: number }, signal?: AbortSignal) => Promise<readonly { readonly id: string }[]>;
  readonly fetchGuildMembers: (guildId: string, after?: string, signal?: AbortSignal) => Promise<readonly { readonly userId: string }[]>;
  readonly sendTyping: (channelId: string, signal?: AbortSignal) => Promise<void>;
  readonly createMessage: (channelId: string, content: string, nonce: string, signal?: AbortSignal) => Promise<{ readonly id: string }>;
  readonly deleteMessage: (channelId: string, messageId: string, signal?: AbortSignal) => Promise<void>;
};

type ParticipantError = Error & { readonly kind?: string; readonly retryAfterMs?: number };

const participant = service as ParticipantClientNamespace;
const factory = (): ParticipantClientFactory => {
  expect(participant.createDiscordParticipantClient).toBeTypeOf("function");
  return participant.createDiscordParticipantClient as ParticipantClientFactory;
};

const IDs = {
  guild: "100000000000000001",
  channel: "100000000000000002",
  user: "100000000000000003",
  message: "100000000000000004",
  laterMessage: "100000000000000005",
} as const;

function userBody() {
  return { id: IDs.user, username: "participant", bot: true };
}

function messageBody(id: string = IDs.message, nonce = "delivery-nonce") {
  return {
    id,
    channel_id: IDs.channel,
    content: "A useful bubble.",
    author: userBody(),
    timestamp: "2026-07-24T00:00:00.000Z",
    nonce,
  };
}

describe("Discord participant REST client", () => {
  it("uses injected loopback Discord client seam", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(userBody())));
    const client = factory()({ token: "bot-token", apiBaseUrl: "http://127.0.0.1:43123/api/v10", fetchImpl });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: IDs.user, username: "participant", bot: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v10/users/@me",
      expect.objectContaining({ headers: { Authorization: "Bot bot-token" } }),
    );
  });

  it("uses Discord v10 by default and does not read an API base URL from environment", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(userBody())));
    const previous = process.env.HENT_AI_DISCORD_API_BASE_URL;
    process.env.HENT_AI_DISCORD_API_BASE_URL = "http://127.0.0.1:9/ignored";
    try {
      await factory()({ token: "bot-token", fetchImpl }).getCurrentUser();
    } finally {
      if (previous === undefined) delete process.env.HENT_AI_DISCORD_API_BASE_URL;
      else process.env.HENT_AI_DISCORD_API_BASE_URL = previous;
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({ headers: { Authorization: "Bot bot-token" } }),
    );
  });

  it("validates configured channel guild ownership before participant work", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: IDs.channel, guild_id: IDs.guild })));
    const client = factory()({ token: "bot-token", fetchImpl });

    await expect(client.verifyChannelGuild(IDs.channel, IDs.guild)).resolves.toEqual({ id: IDs.channel, guildId: IDs.guild });
    await expect(client.verifyChannelGuild(IDs.channel, IDs.user)).rejects.toMatchObject({ kind: "guild_mismatch" });
  });

  it("forwards message and exact member pagination while typing, sending, and deleting", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/messages?") ) return new Response(JSON.stringify([messageBody()]));
      if (url.includes("/members?")) return new Response(JSON.stringify([{ user: { id: IDs.user, bot: false } }]));
      if (url.endsWith("/typing")) return new Response(null, { status: 204 });
      if (init?.method === "POST") return new Response(JSON.stringify(messageBody(IDs.laterMessage)));
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
    const client = factory()({ token: "bot-token", apiBaseUrl: "http://localhost:43123/api/v10", fetchImpl });

    await expect(client.fetchMessages(IDs.channel, { after: IDs.message, limit: 25 })).resolves.toHaveLength(1);
    await expect(client.fetchGuildMembers(IDs.guild, IDs.user)).resolves.toEqual([{ userId: IDs.user, bot: false }]);
    await client.sendTyping(IDs.channel);
    await expect(client.createMessage(IDs.channel, "A useful bubble.", "delivery-nonce")).resolves.toMatchObject({ id: IDs.laterMessage });
    await client.deleteMessage(IDs.channel, IDs.laterMessage);

    expect(new URL(calls[0].url).searchParams.toString()).toBe(new URLSearchParams({ after: IDs.message, limit: "25" }).toString());
    expect(new URL(calls[1].url).searchParams.toString()).toBe(new URLSearchParams({ limit: "1000", after: IDs.user }).toString());
    expect(calls[2]).toMatchObject({ url: `http://localhost:43123/api/v10/channels/${IDs.channel}/typing`, init: { method: "POST" } });
    expect(calls[3]).toMatchObject({ url: `http://localhost:43123/api/v10/channels/${IDs.channel}/messages`, init: { method: "POST" } });
    expect(calls[3].init?.body).toBe(JSON.stringify({ content: "A useful bubble.", nonce: "delivery-nonce", enforce_nonce: true }));
    expect(calls[4]).toMatchObject({ url: `http://localhost:43123/api/v10/channels/${IDs.channel}/messages/${IDs.laterMessage}`, init: { method: "DELETE" } });
  });

  it("makes response-loss retry requests byte-equivalent for the caller-owned nonce", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error("response lost after Discord accepted the nonce");
      return new Response(JSON.stringify(messageBody()));
    });
    const client = factory()({ token: "bot-token", fetchImpl });

    await expect(client.createMessage(IDs.channel, "A useful bubble.", "delivery-nonce")).rejects.toMatchObject({ kind: "network" });
    await expect(client.createMessage(IDs.channel, "A useful bubble.", "delivery-nonce")).resolves.toMatchObject({ id: IDs.message });

    expect(bodies).toEqual([
      "{\"content\":\"A useful bubble.\",\"nonce\":\"delivery-nonce\",\"enforce_nonce\":true}",
      "{\"content\":\"A useful bubble.\",\"nonce\":\"delivery-nonce\",\"enforce_nonce\":true}",
    ]);
  });

  it("fails closed for status, network, malformed-body, snowflake, and caller-abort failures without logging authorization", async () => {
    expect(() => factory()({ token: "bot-token", apiBaseUrl: "https://discord.invalid/api/v10" })).toThrow(expect.objectContaining({ kind: "invalid_request" }));

    const failures: Array<[Response | Error, string, number | undefined]> = [
      [new Response(null, { status: 401 }), "unauthorized", undefined],
      [new Response(null, { status: 403 }), "forbidden", undefined],
      [new Response(null, { status: 404 }), "not_found", undefined],
      [new Response(JSON.stringify({ retry_after: 2.5 }), { status: 429 }), "rate_limited", 2500],
      [new Error("socket reset"), "network", undefined],
      [new Response(JSON.stringify({ id: "not-a-snowflake", username: "participant", bot: true })), "malformed_response", undefined],
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [failure, kind, retryAfterMs] of failures) {
        const fetchImpl = vi.fn(async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        });
        const client = factory()({ token: "bot-token", fetchImpl });
        await expect(client.getCurrentUser()).rejects.toMatchObject({ kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } satisfies Partial<ParticipantError>);
      }

      const malformedMessageClient = factory()({ token: "bot-token", fetchImpl: async () => new Response(JSON.stringify({ id: IDs.message })) });
      await expect(malformedMessageClient.createMessage(IDs.channel, "bubble", "nonce")).rejects.toMatchObject({ kind: "malformed_response" });

      const controller = new AbortController();
      controller.abort();
      const abortedFetch = vi.fn();
      const abortedClient = factory()({ token: "bot-token", fetchImpl: abortedFetch });
      await expect(abortedClient.getCurrentUser(controller.signal)).rejects.toMatchObject({ kind: "aborted" });
      expect(abortedFetch).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
    expect(consoleError).not.toHaveBeenCalled();
  });
});
