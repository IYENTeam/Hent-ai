import sharp from "sharp";

const DISCORD_ATTACHMENT_IMAGE_SIZE_PX = 512;

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type OpenClawMessageSender = {
  sendText?: (channelId: string, text: string) => Promise<string | null>;
  sendImageBuffer?: (
    channelId: string,
    buffer: Buffer,
    filename: string,
    text: string,
  ) => Promise<string | null>;
};

const DISCORD_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS = [250, 750];

function parseRetryAfterMs(res: Response): number | null {
  const retryAfter = res.headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), 10_000);
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export async function resizeImageBufferForDiscordAttachment(buffer: Buffer, contentType = "image/png"): Promise<Buffer> {
  if (!contentType.startsWith("image/") || contentType === "image/gif") return buffer;
  try {
    return await sharp(buffer)
      .resize(DISCORD_ATTACHMENT_IMAGE_SIZE_PX, DISCORD_ATTACHMENT_IMAGE_SIZE_PX, {
        fit: "cover",
        position: "center",
      })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

async function fetchDiscordWithRetry(
  url: string,
  init: RequestInit,
  logger: Logger,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, init);
    if (!DISCORD_RETRY_STATUSES.has(res.status) || attempt >= DEFAULT_RETRY_DELAYS_MS.length) {
      return res;
    }
    const retryAfterMs = parseRetryAfterMs(res) ?? DEFAULT_RETRY_DELAYS_MS[attempt];
    attempt += 1;
    logger.warn(`discord-utils: retrying ${init.method ?? "GET"} ${url} after ${res.status} in ${retryAfterMs}ms`);
    await delay(retryAfterMs);
  }
}

export async function sendTextMessage(
  token: string,
  channelId: string,
  text: string,
  logger: Logger,
  openClawSender?: OpenClawMessageSender,
): Promise<string | null> {
  if (openClawSender?.sendText) {
    const messageId = await openClawSender.sendText(channelId, text);
    if (messageId) return messageId;
    logger.warn("discord-utils: OpenClaw text send unavailable; falling back to Discord REST");
  }

  try {
    const res = await fetchDiscordWithRetry(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text }),
      },
      logger,
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn(`discord-utils: sendText failed ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch (err) {
    logger.error(`discord-utils: sendText error: ${err}`);
    return null;
  }
}

export async function sendImageBufferMessage(
  token: string,
  channelId: string,
  buffer: Buffer,
  filename: string,
  text: string,
  logger: Logger,
  openClawSender?: OpenClawMessageSender,
): Promise<string | null> {
  const attachmentBuffer = await resizeImageBufferForDiscordAttachment(buffer, "image/png");

  if (openClawSender?.sendImageBuffer) {
    const messageId = await openClawSender.sendImageBuffer(channelId, attachmentBuffer, filename, text);
    if (messageId) return messageId;
    logger.warn("discord-utils: OpenClaw image send unavailable; falling back to Discord REST");
  }

  try {
    const boundary = `----HentaiImg${Date.now()}`;
    const parts: Buffer[] = [];

    const jsonPayload = JSON.stringify({
      content: text,
      attachments: [{ id: 0, filename }],
    });
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`,
      ),
    );

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(attachmentBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetchDiscordWithRetry(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
      logger,
    );

    if (!res.ok) {
      const errText = await res.text();
      logger.warn(`discord-utils: sendImageBuffer failed ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch (err) {
    logger.error(`discord-utils: sendImageBuffer error: ${err}`);
    return null;
  }
}

export async function editTextMessage(
  token: string,
  channelId: string,
  messageId: string,
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    const res = await fetchDiscordWithRetry(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text }),
      },
      logger,
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn(`discord-utils: editText failed ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    logger.error(`discord-utils: editText error: ${err}`);
  }
}

export interface DiscordAttachment {
  id: string;
  url: string;
  filename: string;
  content_type?: string;
  size: number;
}

export async function getMessageAttachments(
  token: string,
  channelId: string,
  messageId: string | undefined,
  logger: Logger,
): Promise<DiscordAttachment[]> {
  if (!messageId) return [];
  try {
    const res = await fetchDiscordWithRetry(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        headers: { Authorization: `Bot ${token}` },
      },
      logger,
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn(`discord-utils: getAttachments failed ${res.status}: ${body.slice(0, 200)}`);
      return [];
    }
    const data = (await res.json()) as { attachments?: DiscordAttachment[] };
    return data.attachments ?? [];
  } catch (err) {
    logger.error(`discord-utils: getAttachments error: ${err}`);
    return [];
  }
}

export async function downloadUrl(url: string, logger: Logger): Promise<Buffer | null> {
  try {
    const res = await fetchDiscordWithRetry(url, {}, logger);
    if (!res.ok) {
      logger.warn(`discord-utils: downloadUrl failed ${res.status}: ${url}`);
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logger.error(`discord-utils: downloadUrl error: ${err}`);
    return null;
  }
}
