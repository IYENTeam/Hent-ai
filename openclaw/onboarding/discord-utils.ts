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
      logger.warn(`onboarding: sendText failed ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch (err) {
    logger.error(`onboarding: sendText error: ${err}`);
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
    const boundary = `----OnboardingImg${Date.now()}`;
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
      logger.warn(`onboarding: sendImageBuffer failed ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch (err) {
    logger.error(`onboarding: sendImageBuffer error: ${err}`);
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
      logger.warn(`onboarding: editText failed ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    logger.error(`onboarding: editText error: ${err}`);
  }
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  content_type?: string;
}

export async function getMessageAttachments(
  token: string,
  channelId: string,
  messageId: string,
  logger: Logger,
): Promise<Attachment[]> {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn(`onboarding: getMessage failed ${res.status}: ${body.slice(0, 200)}`);
      return [];
    }
    const data = (await res.json()) as { attachments?: Attachment[] };
    return data.attachments ?? [];
  } catch (err) {
    logger.error(`onboarding: getMessage error: ${err}`);
    return [];
  }
}

export async function downloadUrl(url: string, logger: Logger): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`onboarding: download failed ${res.status} for ${url}`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    logger.error(`onboarding: download error: ${err}`);
    return null;
  }
}
