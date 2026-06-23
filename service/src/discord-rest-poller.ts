/**
 * Discord REST API poller for standalone conversation participation.
 *
 * Periodically fetches new messages from configured Discord channels via REST API,
 * feeds them into the conversation runtime, and sends responses via REST.
 *
 * Unlike discord-watcher.ts (WebSocket Gateway), this uses REST only — no Gateway
 * connection, no bot token conflict with OpenClaw's existing Discord connection.
 */

export type DiscordRestPollerConfig = {
  /** Discord bot token for REST API calls. */
  readonly token: string;
  /** Channel IDs to poll. */
  readonly channels: readonly string[];
  /** Polling interval in milliseconds. Default: 15000 (15s). */
  readonly intervalMs?: number;
  /** Maximum messages per poll. Default: 50. */
  readonly limit?: number;
  /** Bot's own user ID (to skip self-messages). */
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

export type DiscordRestPollerCallbacks = {
  /** Called when new messages are fetched. */
  readonly onMessages?: (channelId: string, messages: readonly DiscordRestMessage[]) => void;
  /** Called when the poller decides to speak. */
  readonly onSpeak?: (channelId: string, text: string, messageId: string | null) => void;
  /** Logging. */
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
};

export type DiscordRestPollerDeps = {
  readonly config: DiscordRestPollerConfig;
  readonly callbacks: DiscordRestPollerCallbacks;
  /**
   * Called for each new user message.
   * Returns { speak: true, text } if the bot should respond.
   */
  readonly handleMessage: (
    channelId: string,
    message: DiscordRestMessage,
  ) => Promise<{ speak: true; text: string } | { speak: false }>;
};

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_LIMIT = 50;
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

/** Split text into ≤2000-char chunks at newline boundaries. */
export function chunkMessage(text: string, maxLen = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf("\n", maxLen);
    if (cutAt <= 0) cutAt = maxLen;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n/, "");
  }
  return chunks;
}

export async function fetchChannelMessages(
  token: string,
  channelId: string,
  opts: { after?: string; limit?: number },
): Promise<DiscordRestMessage[]> {
  const params = new URLSearchParams();
  if (opts.after) params.set("after", opts.after);
  params.set("limit", String(opts.limit ?? DEFAULT_LIMIT));

  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  });

  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") ?? "5");
    throw new RateLimitError(Math.ceil(retryAfter * 1000));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as Array<Record<string, unknown>>;

  // Discord returns newest-first; reverse to chronological order
  return data
    .reverse()
    .map((msg) => {
      const author = msg.author as Record<string, unknown> | undefined;
      return {
        id: String(msg.id ?? ""),
        channelId,
        content: String(msg.content ?? ""),
        authorId: String(author?.id ?? ""),
        authorUsername: String(author?.username ?? ""),
        authorBot: author?.bot === true,
        timestamp: String(msg.timestamp ?? new Date().toISOString()),
      };
    });
}

export async function sendChannelMessage(
  token: string,
  channelId: string,
  content: string,
): Promise<string | null> {
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") ?? "5");
    throw new RateLimitError(Math.ceil(retryAfter * 1000));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord send ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return String(data.id ?? "") || null;
}

export function createDiscordRestPoller(deps: DiscordRestPollerDeps) {
  const { config, callbacks } = deps;
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = config.limit ?? DEFAULT_LIMIT;
  const log = callbacks.log ?? (() => {});

  // Track last seen message ID per channel
  const lastSeenIds = new Map<string, string>();
  // Channels that haven't been polled yet — first poll is catch-up only (set marker, don't process)
  const unseeded = new Set<string>(config.channels);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let activePoll: Promise<void> | null = null;
  // Rate-limit backoff: next allowed poll time (ms)
  let rateLimitUntilMs = 0;

  async function pollChannel(channelId: string): Promise<void> {
    const after = lastSeenIds.get(channelId);
    try {
      const messages = await fetchChannelMessages(config.token, channelId, { after, limit });

      if (messages.length === 0) return;

      // Update last seen ID to the newest user message (not bot-sent IDs)
      const newest = messages[messages.length - 1];
      if (newest) {
        lastSeenIds.set(channelId, newest.id);
      }

      // First poll for an unseeded channel: set marker only, don't process
      if (unseeded.has(channelId)) {
        unseeded.delete(channelId);
        log("info", `poller: catch-up channel=${channelId}, seeded lastSeen=${newest?.id}, skipped ${messages.length} historical messages`);
        return;
      }

      // Filter out bot messages and empty messages
      const userMessages = messages.filter(
        (m) => !m.authorBot && m.content.trim() && m.authorId !== config.botUserId,
      );

      if (userMessages.length > 0) {
        callbacks.onMessages?.(channelId, userMessages);
      }

      // Process each user message through the handler
      for (const msg of userMessages) {
        try {
          const result = await deps.handleMessage(channelId, msg);
          if (result.speak) {
            log("info", `poller: speaking in channel=${channelId}: ${result.text.slice(0, 100)}`);
            const chunks = chunkMessage(result.text);
            for (const chunk of chunks) {
              const sentId = await sendChannelMessage(config.token, channelId, chunk);
              if (sentId) {
                callbacks.onSpeak?.(channelId, chunk, sentId);
              }
            }
          }
        } catch (err) {
          log("error", `poller: handle error channel=${channelId} msg=${msg.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      if (handleRateLimitError(err)) return;
      log("error", `poller: fetch error channel=${channelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleRateLimitError(err: unknown): boolean {
    if (err instanceof RateLimitError) {
      rateLimitUntilMs = Date.now() + err.retryAfterMs;
      log("warn", `poller: rate-limited, backing off ${err.retryAfterMs}ms`);
      return true;
    }
    return false;
  }

  async function pollAll(): Promise<void> {
    if (activePoll || stopped) return;
    if (Date.now() < rateLimitUntilMs) return; // Back off during rate-limit
    const promise = (async () => {
      // Serialize channel polls to avoid concurrent rate-limit hits
      for (const ch of config.channels) {
        if (stopped) break;
        if (Date.now() < rateLimitUntilMs) break;
        await pollChannel(ch);
      }
    })();
    activePoll = promise;
    try {
      await promise;
    } finally {
      activePoll = null;
    }
  }

  return {
    /** Start polling. Performs an initial poll immediately. */
    start() {
      stopped = false;
      log("info", `discord-rest-poller: starting, channels=${config.channels.length}, interval=${intervalMs}ms`);

      // Initial poll
      pollAll().catch((err) =>
        log("error", `poller: initial poll error: ${err instanceof Error ? err.message : String(err)}`),
      );

      timer = setInterval(() => {
        pollAll().catch((err) =>
          log("error", `poller: poll error: ${err instanceof Error ? err.message : String(err)}`),
        );
      }, intervalMs);
    },

    /** Stop polling. Returns a promise that resolves when any in-flight poll completes. */
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (activePoll) {
        await activePoll.catch(() => {});
      }
      log("info", "discord-rest-poller: stopped");
    },

    /** Seed a channel's last-seen marker to avoid processing history on first poll. */
    seedLastSeen(channelId: string, messageId: string) {
      lastSeenIds.set(channelId, messageId);
      unseeded.delete(channelId);
    },

    /** Get current last-seen IDs for persistence. */
    getLastSeenIds(): ReadonlyMap<string, string> {
      return lastSeenIds;
    },
  };
}
