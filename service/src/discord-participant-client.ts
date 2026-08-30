import {
  DiscordParticipantClientError,
  assertSnowflake,
  isAbortError,
  isRecord,
  messagePageLimit,
  readBoundedRetryAfterMs,
  readChannel,
  readJson,
  readMember,
  readMessage,
  readUser,
  requireNonEmptyString,
  type DiscordParticipantChannel,
  type DiscordParticipantMember,
  type DiscordParticipantMessage,
  type DiscordParticipantUser,
} from "./discord-participant-client-parsing.js";

export { DiscordParticipantClientError } from "./discord-participant-client-parsing.js";
export type {
  DiscordParticipantChannel,
  DiscordParticipantErrorKind,
  DiscordParticipantMember,
  DiscordParticipantMessage,
  DiscordParticipantUser,
} from "./discord-participant-client-parsing.js";

export const DISCORD_PARTICIPANT_API_BASE_URL = "https://discord.com/api/v10";

const ROSTER_PAGE_LIMIT = 1000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DiscordParticipantClientOptions = {
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  /** Constructor-only test seam. Production composition uses the fixed v10 default. */
  readonly apiBaseUrl?: string;
};

export type DiscordParticipantMessagePage = {
  readonly after?: string;
  readonly limit?: number;
};

export type DiscordParticipantClient = {
  readonly getCurrentUser: (signal?: AbortSignal) => Promise<DiscordParticipantUser>;
  readonly verifyChannelGuild: (channelId: string, expectedGuildId: string, signal?: AbortSignal) => Promise<DiscordParticipantChannel>;
  readonly fetchMessages: (channelId: string, page: DiscordParticipantMessagePage, signal?: AbortSignal) => Promise<readonly DiscordParticipantMessage[]>;
  readonly fetchGuildMembers: (guildId: string, after?: string, signal?: AbortSignal) => Promise<readonly DiscordParticipantMember[]>;
  readonly sendTyping: (channelId: string, signal?: AbortSignal) => Promise<void>;
  readonly createMessage: (channelId: string, content: string, nonce: string, signal?: AbortSignal) => Promise<DiscordParticipantMessage>;
  readonly deleteMessage: (channelId: string, messageId: string, signal?: AbortSignal) => Promise<void>;
};

export function createDiscordParticipantClient(options: DiscordParticipantClientOptions): DiscordParticipantClient {
  const token = requireNonEmptyString(options.token, "invalid_request");
  const baseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function request(path: string, init: RequestInit, expectedStatus: number, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw new DiscordParticipantClientError("aborted");
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bot ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new DiscordParticipantClientError("aborted");
      throw new DiscordParticipantClientError("network");
    }
    if (response.status === 429) {
      throw new DiscordParticipantClientError("rate_limited", 429, await readBoundedRetryAfterMs(response));
    }
    if (response.status === 401) throw new DiscordParticipantClientError("unauthorized", 401);
    if (response.status === 403) throw new DiscordParticipantClientError("forbidden", 403);
    if (response.status === 404) throw new DiscordParticipantClientError("not_found", 404);
    if (response.status !== expectedStatus) throw new DiscordParticipantClientError("unexpected_status", response.status);
    return response;
  }

  return {
    async getCurrentUser(signal) {
      return readUser(await readJson(await request("/users/@me", {}, 200, signal)));
    },

    async verifyChannelGuild(channelId, expectedGuildId, signal) {
      assertSnowflake(channelId);
      assertSnowflake(expectedGuildId);
      const value = await readJson(await request(`/channels/${channelId}`, {}, 200, signal));
      const channel = readChannel(value);
      if (channel.id !== channelId || channel.guildId !== expectedGuildId) {
        throw new DiscordParticipantClientError("guild_mismatch");
      }
      return channel;
    },

    async fetchMessages(channelId, page, signal) {
      assertSnowflake(channelId);
      const params = new URLSearchParams();
      if (page.after !== undefined) {
        assertSnowflake(page.after);
        params.set("after", page.after);
      }
      params.set("limit", String(messagePageLimit(page.limit)));
      const value = await readJson(await request(`/channels/${channelId}/messages?${params.toString()}`, {}, 200, signal));
      if (!Array.isArray(value)) throw new DiscordParticipantClientError("malformed_response");
      return value.map((message) => readMessage(message, channelId));
    },

    async fetchGuildMembers(guildId, after, signal) {
      assertSnowflake(guildId);
      const params = new URLSearchParams({ limit: String(ROSTER_PAGE_LIMIT) });
      if (after !== undefined) {
        assertSnowflake(after);
        params.set("after", after);
      }
      const value = await readJson(await request(`/guilds/${guildId}/members?${params.toString()}`, {}, 200, signal));
      if (!Array.isArray(value)) throw new DiscordParticipantClientError("malformed_response");
      return value.map(readMember);
    },

    async sendTyping(channelId, signal) {
      assertSnowflake(channelId);
      await request(`/channels/${channelId}/typing`, { method: "POST" }, 204, signal);
    },

    async createMessage(channelId, content, nonce, signal) {
      assertSnowflake(channelId);
      if (typeof content !== "string" || content.trim().length === 0 || content.length > 1800) {
        throw new DiscordParticipantClientError("invalid_request");
      }
      if (typeof nonce !== "string" || nonce.trim().length === 0 || nonce.length > 25) {
        throw new DiscordParticipantClientError("invalid_request");
      }
      const body = JSON.stringify({ content, nonce, enforce_nonce: true });
      const value = await readJson(await request(`/channels/${channelId}/messages`, { method: "POST", body }, 200, signal));
      const message = readMessage(value, channelId);
      if (!isRecord(value) || value.nonce !== nonce) throw new DiscordParticipantClientError("malformed_response");
      return message;
    },

    async deleteMessage(channelId, messageId, signal) {
      assertSnowflake(channelId);
      assertSnowflake(messageId);
      await request(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" }, 204, signal);
    },
  };
}

function normalizeApiBaseUrl(value: string | undefined): string {
  if (value === undefined) return DISCORD_PARTICIPANT_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DiscordParticipantClientError("invalid_request");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DiscordParticipantClientError("invalid_request");
  }
  if (!isLoopbackHost(parsed.hostname)) throw new DiscordParticipantClientError("invalid_request");
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
