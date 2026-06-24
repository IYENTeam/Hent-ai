export type DiscordRestPollerConfig = {
  readonly token: string;
  readonly channels: readonly string[];
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly botUserId?: string;
};

export type DiscordRestMessage = {
  readonly id: string;
  readonly channelId: string;
  readonly content: string;
  readonly authorId: string;
  readonly authorUsername: string;
  readonly authorBot: boolean;
  readonly timestamp: string;
};

export type DiscordFetchOptions = {
  readonly after?: string;
  readonly limit?: number;
};

export type DiscordRestClient = {
  readonly fetchMessages: (channelId: string, options: DiscordFetchOptions) => Promise<readonly DiscordRestMessage[]>;
  readonly sendMessage: (channelId: string, content: string) => Promise<string | null>;
};

export type DiscordRestPollerCallbacks = {
  readonly onMessages?: (channelId: string, messages: readonly DiscordRestMessage[]) => void;
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
};

export type DiscordRestPollerDeps = {
  readonly config: DiscordRestPollerConfig;
  readonly client?: DiscordRestClient;
  readonly callbacks?: DiscordRestPollerCallbacks;
  readonly onMessage: (message: DiscordRestMessage) => Promise<void> | void;
  readonly now?: () => number;
};

export type DiscordRestPoller = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly pollOnce: () => Promise<void>;
  readonly seedLastSeen: (channelId: string, messageId: string) => void;
  readonly getLastSeenIds: () => ReadonlyMap<string, string>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_LIMIT = 50;
const DISCORD_MAX_LIMIT = 100;
const DISCORD_MAX_MESSAGE_LENGTH = 2_000;

export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Discord rate limited for ${retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

export function chunkMessage(text: string, maxLen = DISCORD_MAX_MESSAGE_LENGTH): readonly string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const newlineIndex = remaining.lastIndexOf("\n", maxLen);
    const splitAt = newlineIndex > 0 ? newlineIndex : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

export function createDiscordRestClient(token: string, fetchImpl: FetchLike = globalThis.fetch): DiscordRestClient {
  return {
    fetchMessages: (channelId, options) => fetchChannelMessages(token, channelId, options, fetchImpl),
    sendMessage: (channelId, content) => sendChannelMessage(token, channelId, content, fetchImpl),
  };
}

export async function fetchChannelMessages(
  token: string,
  channelId: string,
  options: DiscordFetchOptions,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<readonly DiscordRestMessage[]> {
  const params = new URLSearchParams();
  const after = options.after?.trim();
  if (after) params.set("after", after);
  params.set("limit", String(limitForDiscord(options.limit)));

  const response = await fetchImpl(`${DISCORD_API_BASE}/channels/${channelId}/messages?${params}`, {
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  });
  await throwDiscordError(response, "Discord API");

  return readDiscordMessages(await response.json(), channelId);
}

export async function sendChannelMessage(
  token: string,
  channelId: string,
  content: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string | null> {
  const response = await fetchImpl(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  await throwDiscordError(response, "Discord send");

  const body = await response.json();
  return recordString(body, "id");
}

export function createDiscordRestPoller(deps: DiscordRestPollerDeps): DiscordRestPoller {
  const client = deps.client ?? createDiscordRestClient(deps.config.token);
  const intervalMs = positiveInteger(deps.config.intervalMs, DEFAULT_INTERVAL_MS);
  const limit = limitForDiscord(deps.config.limit);
  const log = deps.callbacks?.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const lastSeenIds = new Map<string, string>();
  const unseeded = new Set(deps.config.channels);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let activePoll: Promise<void> | null = null;
  let rateLimitUntilMs = 0;

  async function pollChannel(channelId: string): Promise<void> {
    const messages = await client.fetchMessages(channelId, { after: lastSeenIds.get(channelId), limit });
    const newest = messages.at(-1);
    if (newest) lastSeenIds.set(channelId, newest.id);

    if (unseeded.has(channelId)) {
      unseeded.delete(channelId);
      log("info", `discord-rest-poller: seeded channel=${channelId} lastSeen=${newest?.id ?? "unknown"} skipped=${messages.length}`);
      return;
    }
    if (messages.length === 0) return;

    const nonEmptyMessages = messages.filter((message) => message.content.trim().length > 0);
    if (nonEmptyMessages.length > 0) deps.callbacks?.onMessages?.(channelId, nonEmptyMessages);
    for (const message of nonEmptyMessages) await deps.onMessage(message);
  }

  async function runPoll(): Promise<void> {
    if (stopped || now() < rateLimitUntilMs) return;
    for (const channelId of deps.config.channels) {
      if (stopped || now() < rateLimitUntilMs) return;
      try {
        await pollChannel(channelId);
      } catch (error) {
        if (error instanceof RateLimitError) {
          rateLimitUntilMs = now() + error.retryAfterMs;
          log("warn", `discord-rest-poller: rate limited for ${error.retryAfterMs}ms`);
          return;
        }
        log("error", `discord-rest-poller: channel=${channelId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function pollOnce(): Promise<void> {
    if (activePoll) return activePoll;
    activePoll = runPoll();
    try {
      await activePoll;
    } finally {
      activePoll = null;
    }
  }

  return {
    start() {
      if (timer) return;
      stopped = false;
      log("info", `discord-rest-poller: starting channels=${deps.config.channels.length} intervalMs=${intervalMs}`);
      void pollOnce();
      timer = setInterval(() => void pollOnce(), intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (activePoll) await activePoll;
      log("info", "discord-rest-poller: stopped");
    },
    pollOnce,
    seedLastSeen(channelId, messageId) {
      lastSeenIds.set(channelId, messageId);
      unseeded.delete(channelId);
    },
    getLastSeenIds() {
      return lastSeenIds;
    },
  };
}

async function throwDiscordError(response: Response, label: string): Promise<void> {
  if (response.status === 429) throw new RateLimitError(retryAfterMs(response));
  if (response.ok) return;
  const body = await response.text();
  throw new Error(`${label} ${response.status}: ${body.slice(0, 200)}`);
}

function readDiscordMessages(value: unknown, channelId: string): readonly DiscordRestMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: DiscordRestMessage[] = [];
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = readDiscordMessage(value[index], channelId);
    if (message) messages.push(message);
  }
  return messages;
}

function readDiscordMessage(value: unknown, channelId: string): DiscordRestMessage | null {
  if (!isRecord(value)) return null;
  const author = isRecord(value.author) ? value.author : {};
  const id = recordString(value, "id");
  if (!id) return null;
  return {
    id,
    channelId,
    content: recordString(value, "content") ?? "",
    authorId: recordString(author, "id") ?? "",
    authorUsername: recordString(author, "username") ?? "",
    authorBot: author.bot === true,
    timestamp: recordString(value, "timestamp") ?? new Date().toISOString(),
  };
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After") ?? "5");
  return Math.ceil((Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1_000);
}

function limitForDiscord(value: number | undefined): number {
  return Math.min(DISCORD_MAX_LIMIT, positiveInteger(value, DEFAULT_LIMIT));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function recordString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
