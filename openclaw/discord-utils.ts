export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export async function sendTextMessage(
  token: string,
  channelId: string,
  text: string,
  logger: Logger,
): Promise<string | null> {
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
): Promise<string | null> {
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
