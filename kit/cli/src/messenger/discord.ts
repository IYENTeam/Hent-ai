// Ported from Dori (sisyphuslabs/omo-dori-mode-experimental @ 40034ad,
// skills/dori-mode/scripts/src/messenger/discord.ts), MIT License, Copyright (c) 2026 YeonGyu Kim.
// Changes: guardText's "$(" refusal is not ported (the kit is argv-only and replies may
// legitimately contain shell snippets); Discord surface reshaped for the Hent-ai bridge.

import type { Clock } from "../run.ts";
import { type Http, type HttpRequest, MessengerError, withBackoff } from "./http.ts";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** `HENT_DISCORD_API_BASE` is test-only (points the kit at a fake Discord server). */
export const discordApiBase = (env: Readonly<Record<string, string | undefined>> = process.env): string => env.HENT_DISCORD_API_BASE || DISCORD_API_BASE;

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export type SendOptions = { readonly replyToMessageId?: string; readonly nonce?: string };
export type FileUpload = { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer>; readonly contentType?: string };

export type DiscordUser = { readonly id: string; readonly username: string; readonly bot?: boolean };
export type DiscordAttachment = { readonly id: string; readonly url: string; readonly filename: string; readonly content_type?: string };
export type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly author: DiscordUser;
  readonly content: string;
  readonly timestamp: string;
  readonly attachments?: readonly DiscordAttachment[];
  readonly message_reference?: { readonly message_id?: string };
};

const messageBody = (content: string, opts: SendOptions): Record<string, unknown> => ({
  content,
  allowed_mentions: { parse: [] },
  ...(opts.replyToMessageId ? { message_reference: { message_id: opts.replyToMessageId, fail_if_not_exists: false } } : {}),
  ...(opts.nonce ? { nonce: opts.nonce, enforce_nonce: true } : {}),
});

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = discordApiBase(),
  ) {}

  private async request<T>(method: HttpRequest["method"], path: string, body?: Record<string, unknown> | FormData): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bot ${this.botToken}` };
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await withBackoff(this.http, this.clock, { method, url: `${this.base}${path}`, headers, ...(payload !== undefined ? { body: payload } : {}) }, undefined, retryAfter);
    if (res.status >= 300) throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  /** Sends text verbatim (no shell guard: the kit never builds commands from message text). Returns the message id. */
  async send(channelId: string, content: string, opts: SendOptions = {}): Promise<string> {
    return (await this.request<{ id: string }>("POST", `/channels/${channelId}/messages`, messageBody(content, opts))).id;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { content, allowed_mentions: { parse: [] } });
  }

  async typing(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${channelId}/typing`);
  }

  /** Multipart upload: `payload_json` carries the message, `files[0]` the attachment. Returns the message id. */
  async sendWithFile(channelId: string, content: string, file: FileUpload, opts: SendOptions = {}): Promise<string> {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...messageBody(content, opts), attachments: [{ id: 0, filename: file.name }] }));
    form.append("files[0]", new Blob([file.bytes], { type: file.contentType ?? "application/octet-stream" }), file.name);
    return (await this.request<{ id: string }>("POST", `/channels/${channelId}/messages`, form)).id;
  }

  async listMessages(channelId: string, query: { readonly after?: string; readonly limit?: number } = {}): Promise<DiscordMessage[]> {
    const params = new URLSearchParams();
    if (query.after) params.set("after", query.after);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.size ? `?${params}` : "";
    return this.request<DiscordMessage[]>("GET", `/channels/${channelId}/messages${qs}`);
  }

  async me(): Promise<DiscordUser> {
    return this.request<DiscordUser>("GET", "/users/@me");
  }

  async gatewayUrl(): Promise<string> {
    return (await this.request<{ url: string }>("GET", "/gateway/bot")).url;
  }
}
