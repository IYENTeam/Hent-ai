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
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text }),
      },
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
  if (openClawSender?.sendImageBuffer) {
    const messageId = await openClawSender.sendImageBuffer(channelId, buffer, filename, text);
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
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
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
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text }),
      },
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
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        headers: { Authorization: `Bot ${token}` },
      },
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
    const res = await fetch(url);
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
