const DISCORD_SNOWFLAKE_RE = /^[1-9][0-9]{0,19}$/;
const MAX_DISCORD_SNOWFLAKE = (1n << 64n) - 1n;
const MAX_MESSAGE_PAGE_LIMIT = 100;
const MAX_RETRY_AFTER_MS = 60_000;

export type DiscordParticipantErrorKind =
  | "aborted"
  | "forbidden"
  | "guild_mismatch"
  | "invalid_request"
  | "malformed_response"
  | "network"
  | "not_found"
  | "rate_limited"
  | "unauthorized"
  | "unexpected_status";

export class DiscordParticipantClientError extends Error {
  constructor(
    readonly kind: DiscordParticipantErrorKind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Discord participant request failed: ${kind}${status === undefined ? "" : ` (${status})`}`);
    this.name = "DiscordParticipantClientError";
  }
}

export type DiscordParticipantUser = {
  readonly id: string;
  readonly username: string;
  readonly bot: boolean;
};

export type DiscordParticipantChannel = {
  readonly id: string;
  readonly guildId: string;
};

export type DiscordParticipantMessage = {
  readonly id: string;
  readonly channelId: string;
  readonly content: string;
  readonly author: DiscordParticipantUser;
  readonly timestamp: string;
  readonly mentions: readonly string[];
  readonly replyTo: { readonly messageId: string; readonly authorId: string } | null;
};

export type DiscordParticipantMember = {
  readonly userId: string;
  readonly bot: boolean;
};

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DiscordParticipantClientError("malformed_response");
  }
}

export async function readBoundedRetryAfterMs(response: Response): Promise<number | undefined> {
  const headerSeconds = Number(response.headers.get("Retry-After"));
  const headerMs = secondsToBoundedMilliseconds(headerSeconds);
  if (headerMs !== undefined) return headerMs;
  try {
    const value = await response.json();
    return isRecord(value) ? secondsToBoundedMilliseconds(value.retry_after) : undefined;
  } catch {
    return undefined;
  }
}

export function readUser(value: unknown): DiscordParticipantUser {
  if (!isRecord(value)) throw new DiscordParticipantClientError("malformed_response");
  const id = readSnowflake(value.id);
  const username = readNonEmptyString(value.username);
  if (value.bot !== undefined && typeof value.bot !== "boolean") throw new DiscordParticipantClientError("malformed_response");
  return { id, username, bot: value.bot === true };
}

export function readChannel(value: unknown): DiscordParticipantChannel {
  if (!isRecord(value)) throw new DiscordParticipantClientError("malformed_response");
  return { id: readSnowflake(value.id), guildId: readSnowflake(value.guild_id) };
}

export function readMessage(value: unknown, channelId: string): DiscordParticipantMessage {
  if (!isRecord(value) || value.channel_id !== channelId) throw new DiscordParticipantClientError("malformed_response");
  if (typeof value.content !== "string") throw new DiscordParticipantClientError("malformed_response");
  const timestamp = readNonEmptyString(value.timestamp);
  if (!Number.isFinite(Date.parse(timestamp))) throw new DiscordParticipantClientError("malformed_response");
  return {
    id: readSnowflake(value.id),
    channelId,
    content: value.content,
    author: readUser(value.author),
    timestamp,
    mentions: readMentionIds(value.mentions),
    replyTo: readReplyTo(value),
  };
}

function readMentionIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DiscordParticipantClientError("malformed_response");
  const ids = value.map((mention) => readUser(mention).id);
  return [...new Set(ids)];
}

function readReplyTo(value: Readonly<Record<string, unknown>>): { readonly messageId: string; readonly authorId: string } | null {
  const reference = value.message_reference;
  if (reference === undefined || reference === null) return null;
  if (!isRecord(reference)) throw new DiscordParticipantClientError("malformed_response");
  const messageId = readSnowflake(reference.message_id);
  if (value.referenced_message === undefined || value.referenced_message === null) return null;
  if (!isRecord(value.referenced_message)) throw new DiscordParticipantClientError("malformed_response");
  if (readSnowflake(value.referenced_message.id) !== messageId) throw new DiscordParticipantClientError("malformed_response");
  return { messageId, authorId: readUser(value.referenced_message.author).id };
}

export function readMember(value: unknown): DiscordParticipantMember {
  if (!isRecord(value) || !isRecord(value.user)) throw new DiscordParticipantClientError("malformed_response");
  const userId = readSnowflake(value.user.id);
  if (value.user.bot !== undefined && typeof value.user.bot !== "boolean") throw new DiscordParticipantClientError("malformed_response");
  return { userId, bot: value.user.bot === true };
}

export function assertSnowflake(value: string): void {
  if (!isSnowflake(value)) throw new DiscordParticipantClientError("invalid_request");
}

export function requireNonEmptyString(value: string, kind: DiscordParticipantErrorKind): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new DiscordParticipantClientError(kind);
  return value;
}

export function messagePageLimit(value: number | undefined): number {
  if (value === undefined) return MAX_MESSAGE_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_MESSAGE_PAGE_LIMIT) throw new DiscordParticipantClientError("invalid_request");
  return value;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function secondsToBoundedMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = Math.ceil(value * 1_000);
  return milliseconds <= MAX_RETRY_AFTER_MS ? milliseconds : undefined;
}

function readSnowflake(value: unknown): string {
  if (typeof value !== "string" || !isSnowflake(value)) throw new DiscordParticipantClientError("malformed_response");
  return value;
}

function isSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_RE.test(value) && BigInt(value) <= MAX_DISCORD_SNOWFLAKE;
}

function readNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new DiscordParticipantClientError("malformed_response");
  return value;
}
