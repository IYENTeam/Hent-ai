// Bridge local API contract (ADR-0002): types, limits and strict parsers shared by
// the `hent bridge` server and the session-side CLI. Pure: no I/O, no runtime deps.
//
// Requests (queries and bodies) are strict: unknown or duplicated keys are rejected.
// Responses are parsed leniently on extra keys so a newer bridge can add fields.

export const BRIDGE_DEFAULT_PORT = 8789;
export const MAX_INBOX_WAIT_SECONDS = 25;
export const MAX_INBOX_EVENTS = 100;
export const MAX_HISTORY_LIMIT = 100;
export const DEFAULT_HISTORY_LIMIT = 50;
export const CONSUMER_LEASE_TTL_MS = 60_000;
export const MAX_BASE_NONCE_LENGTH = 22;
export const MAX_NONCE_LENGTH = 25;
export const MAX_MESSAGE_TEXT_LENGTH = 2000;
export const MAX_SEND_FILE_BYTES = 8 * 1024 * 1024;
export const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const BRIDGE_ROUTES = {
  inbox: "/v1/inbox",
  history: "/v1/history",
  send: "/v1/send",
  edit: "/v1/edit",
  typing: "/v1/typing",
  handled: "/v1/handled",
  session: "/v1/session",
  health: "/v1/health",
} as const;

export type BridgeErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "lease_held"
  | "discord_error"
  | "gateway_fatal";

export interface BridgeError {
  error: BridgeErrorCode;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type InboxEventKind = "message_create" | "message_update" | "message_delete";

export interface InboxAttachment {
  url: string;
  contentType: string | null;
  name: string;
}

export interface InboxEvent {
  seq: number;
  kind: InboxEventKind;
  channelId: string;
  guildId: string | null;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  authorIsSelf: boolean;
  authorName: string;
  content: string;
  referencedMessageId: string | null;
  attachments: InboxAttachment[];
  createdAt: string;
}

export interface InboxQuery {
  consumer: string;
  wait: number;
  ack: number | null;
  takeover: boolean;
}

export interface InboxResponse {
  events: InboxEvent[];
  cursor: number;
}

export interface HistoryQuery {
  channelId: string;
  limit: number;
}

export interface HistoryResponse {
  events: InboxEvent[];
}

export interface SendRequest {
  channelId: string;
  text: string;
  replyToMessageId: string | null;
  nonce: string;
}

export interface SendFile {
  name: string;
  contentType: string;
  data: Blob;
}

export interface MultipartSendRequest extends SendRequest {
  file: SendFile;
}

export interface SendResponse {
  messageId: string;
}

export interface EditRequest {
  channelId: string;
  messageId: string;
  text: string;
}

export interface TypingRequest {
  channelId: string;
}

export type HandledHow = "replied" | "skipped";

export interface HandledRequest {
  messageId: string;
  how: HandledHow;
}

export type SessionAgent = "claude" | "codex";

/** The brain is an interactive agent in a herdr pane (`pane` is a herdr pane id such as `w1:p3`). */
export interface SessionRequest {
  agent: SessionAgent;
  sessionId: string;
  pane: string;
  cwd: string;
}

export type GatewayState = "connected" | "reconnecting" | "fatal";

export interface ConsumerStatus {
  name: string;
  cursor: number;
  leaseExpiresAt: string | null;
}

export interface HealthResponse {
  gateway: GatewayState;
  botUserId: string | null;
  lastSeq: number;
  consumers: ConsumerStatus[];
}

/**
 * Next consumer cursor after an `ack`. Monotonic: an absent ack or one at or
 * below `current` leaves the cursor unchanged. When `lastSeq` is given the
 * cursor never passes it, so an ack from the future cannot skip unjournaled events.
 */
export function advanceCursor(current: number, ack: number | null | undefined, lastSeq?: number): number {
  if (ack === null || ack === undefined || !Number.isSafeInteger(ack) || ack <= current) return current;
  const target = lastSeq === undefined ? ack : Math.min(ack, lastSeq);
  return Math.max(current, target);
}

const BASE_NONCE = /^[A-Za-z0-9_]{1,22}$/;
const ANY_NONCE = /^([A-Za-z0-9_]{1,22})(?:-(\d{1,3}))?$/;

export function isBaseNonce(value: string): boolean {
  return BASE_NONCE.test(value);
}

export function chunkNonce(base: string, index: number): string {
  if (!isBaseNonce(base)) throw new RangeError(`invalid base nonce: ${JSON.stringify(base)}`);
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`invalid chunk index: ${index}`);
  const nonce = `${base}-${index}`;
  if (nonce.length > MAX_NONCE_LENGTH) {
    throw new RangeError(`chunk nonce exceeds ${MAX_NONCE_LENGTH} chars: ${nonce}`);
  }
  return nonce;
}

function isSendNonce(value: string): boolean {
  return value.length <= MAX_NONCE_LENGTH && ANY_NONCE.test(value);
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONSUMER = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const UINT = /^(0|[1-9]\d{0,15})$/;
const HERDR_PANE = /^[A-Za-z0-9]{1,16}:p[0-9]{1,9}$/;

// Control characters are rejected in pane targets and cwd (argv safety, no terminal injection).
const CONTROL = /[\u0000-\u001f\u007f]/;

type Obj = Record<string, unknown>;

class ParseError extends Error {}

function fail(message: string): never {
  throw new ParseError(message);
}

function run<T>(fn: () => T): ParseResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message };
    throw err;
  }
}

function asObject(input: unknown, what: string): Obj {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(`${what} must be a JSON object`);
  return input as Obj;
}

function onlyKeys(obj: Obj, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${what}: unknown field "${key}"`);
  }
}

function id(obj: Obj, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !ID.test(v)) fail(`${key} must match [A-Za-z0-9_-]{1,64}`);
  return v;
}

function optionalId(obj: Obj, key: string): string | null {
  return obj[key] === undefined || obj[key] === null ? null : id(obj, key);
}

function str(obj: Obj, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") fail(`${key} must be a string`);
  return v;
}

function bool(obj: Obj, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") fail(`${key} must be a boolean`);
  return v;
}

function uint(obj: Obj, key: string, min = 0): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) fail(`${key} must be an integer >= ${min}`);
  return v;
}

function oneOf<T extends string>(obj: Obj, key: string, values: readonly T[]): T {
  const v = obj[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    fail(`${key} must be one of ${values.join("|")}`);
  }
  return v as T;
}

function messageText(obj: Obj, allowEmpty: boolean): string {
  const text = str(obj, "text");
  if (!allowEmpty && text.length === 0) fail("text must not be empty");
  if (text.length > MAX_MESSAGE_TEXT_LENGTH) fail(`text exceeds ${MAX_MESSAGE_TEXT_LENGTH} chars`);
  return text;
}

function isoTime(obj: Obj, key: string): string {
  const v = str(obj, key);
  if (Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) fail(`${key} must be an ISO-8601 timestamp`);
  return v;
}

function queryParams(params: URLSearchParams, allowed: readonly string[], what: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of params) {
    if (!allowed.includes(key)) fail(`${what}: unknown parameter "${key}"`);
    if (out.has(key)) fail(`${what}: duplicate parameter "${key}"`);
    out.set(key, value);
  }
  return out;
}

function queryUint(q: Map<string, string>, key: string): number | null {
  const v = q.get(key);
  if (v === undefined) return null;
  if (!UINT.test(v)) fail(`${key} must be a non-negative integer`);
  return Number(v);
}

export function parseInboxQuery(params: URLSearchParams): ParseResult<InboxQuery> {
  return run(() => {
    const q = queryParams(params, ["consumer", "wait", "ack", "takeover"], "inbox query");
    const consumer = q.get("consumer");
    if (consumer === undefined || !CONSUMER.test(consumer)) fail("consumer must match [A-Za-z0-9_-]{1,64}");
    const wait = queryUint(q, "wait") ?? 0;
    if (wait > MAX_INBOX_WAIT_SECONDS) fail(`wait must be <= ${MAX_INBOX_WAIT_SECONDS}`);
    const ack = queryUint(q, "ack");
    const takeoverRaw = q.get("takeover");
    if (takeoverRaw !== undefined && takeoverRaw !== "0" && takeoverRaw !== "1") fail("takeover must be 0 or 1");
    return { consumer, wait, ack, takeover: takeoverRaw === "1" };
  });
}

export function parseHistoryQuery(params: URLSearchParams): ParseResult<HistoryQuery> {
  return run(() => {
    const q = queryParams(params, ["channelId", "limit"], "history query");
    const channelId = q.get("channelId");
    if (channelId === undefined || !ID.test(channelId)) fail("channelId must match [A-Za-z0-9_-]{1,64}");
    const limit = queryUint(q, "limit") ?? DEFAULT_HISTORY_LIMIT;
    if (limit < 1 || limit > MAX_HISTORY_LIMIT) fail(`limit must be between 1 and ${MAX_HISTORY_LIMIT}`);
    return { channelId, limit };
  });
}

const SEND_KEYS = ["channelId", "text", "replyToMessageId", "nonce"] as const;

function sendBody(input: unknown, allowEmptyText: boolean): SendRequest {
  const obj = asObject(input, "send request");
  onlyKeys(obj, SEND_KEYS, "send request");
  const channelId = id(obj, "channelId");
  const text = messageText(obj, allowEmptyText);
  const replyToMessageId = optionalId(obj, "replyToMessageId");
  const nonce = str(obj, "nonce");
  if (!isSendNonce(nonce)) {
    fail(
      `nonce must be [A-Za-z0-9_]{1,${MAX_BASE_NONCE_LENGTH}} optionally followed by -<chunk>, at most ${MAX_NONCE_LENGTH} chars`,
    );
  }
  return { channelId, text, replyToMessageId, nonce };
}

export function parseSendRequest(input: unknown): ParseResult<SendRequest> {
  return run(() => sendBody(input, false));
}

export function parseSendMultipart(form: FormData): ParseResult<MultipartSendRequest> {
  return run(() => {
    for (const key of new Set(form.keys())) {
      if (key !== "payload" && key !== "file") fail(`multipart send: unknown field "${key}"`);
      if (form.getAll(key).length !== 1) fail(`multipart send: duplicate field "${key}"`);
    }
    const payload = form.get("payload");
    if (typeof payload !== "string") fail("multipart send: payload must be a JSON string field");
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      fail("multipart send: payload is not valid JSON");
    }
    const base = sendBody(json, true);
    const file = form.get("file");
    if (!(file instanceof Blob)) fail("multipart send: file must be a file field");
    const name = file instanceof File ? file.name : "";
    if (name.length === 0 || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
      fail("multipart send: file needs a plain file name (1-255 chars, no path separators)");
    }
    if (file.size === 0) fail("multipart send: file is empty");
    if (file.size > MAX_SEND_FILE_BYTES) fail(`multipart send: file exceeds ${MAX_SEND_FILE_BYTES} bytes`);
    return { ...base, file: { name, contentType: file.type || "application/octet-stream", data: file } };
  });
}

export function parseEditRequest(input: unknown): ParseResult<EditRequest> {
  return run(() => {
    const obj = asObject(input, "edit request");
    onlyKeys(obj, ["channelId", "messageId", "text"], "edit request");
    return { channelId: id(obj, "channelId"), messageId: id(obj, "messageId"), text: messageText(obj, false) };
  });
}

export function parseTypingRequest(input: unknown): ParseResult<TypingRequest> {
  return run(() => {
    const obj = asObject(input, "typing request");
    onlyKeys(obj, ["channelId"], "typing request");
    return { channelId: id(obj, "channelId") };
  });
}

export function parseHandledRequest(input: unknown): ParseResult<HandledRequest> {
  return run(() => {
    const obj = asObject(input, "handled request");
    onlyKeys(obj, ["messageId", "how"], "handled request");
    return { messageId: id(obj, "messageId"), how: oneOf(obj, "how", ["replied", "skipped"] as const) };
  });
}

export function parseSessionRequest(input: unknown): ParseResult<SessionRequest> {
  return run(() => {
    const obj = asObject(input, "session request");
    onlyKeys(obj, ["agent", "sessionId", "pane", "cwd"], "session request");
    const agent = oneOf(obj, "agent", ["claude", "codex"] as const);
    const sessionId = str(obj, "sessionId");
    if (!SESSION_ID.test(sessionId)) fail("sessionId must match [A-Za-z0-9._-]{1,128}");
    const pane = str(obj, "pane");
    if (!HERDR_PANE.test(pane)) fail("pane must be a herdr pane id like w1:p3");
    const cwd = str(obj, "cwd");
    if (!cwd.startsWith("/") || cwd.length > 4096 || CONTROL.test(cwd)) fail("cwd must be an absolute path");
    return { agent, sessionId, pane, cwd };
  });
}

function inboxEvent(input: unknown): InboxEvent {
  const obj = asObject(input, "inbox event");
  const attachmentsRaw = obj.attachments;
  if (!Array.isArray(attachmentsRaw)) fail("attachments must be an array");
  const attachments = attachmentsRaw.map((a): InboxAttachment => {
    const att = asObject(a, "attachment");
    const url = str(att, "url");
    if (!/^https?:\/\//.test(url)) fail("attachment url must be http(s)");
    const contentType = att.contentType === null ? null : str(att, "contentType");
    return { url, contentType, name: str(att, "name") };
  });
  return {
    seq: uint(obj, "seq", 1),
    kind: oneOf(obj, "kind", ["message_create", "message_update", "message_delete"] as const),
    channelId: id(obj, "channelId"),
    guildId: obj.guildId === null ? null : id(obj, "guildId"),
    messageId: id(obj, "messageId"),
    authorId: id(obj, "authorId"),
    authorIsBot: bool(obj, "authorIsBot"),
    authorIsSelf: bool(obj, "authorIsSelf"),
    authorName: str(obj, "authorName"),
    content: str(obj, "content"),
    referencedMessageId: obj.referencedMessageId === null ? null : id(obj, "referencedMessageId"),
    attachments,
    createdAt: isoTime(obj, "createdAt"),
  };
}

function eventList(obj: Obj, max: number): InboxEvent[] {
  const raw = obj.events;
  if (!Array.isArray(raw)) fail("events must be an array");
  if (raw.length > max) fail(`events exceeds ${max}`);
  const events = raw.map(inboxEvent);
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.seq <= events[i - 1]!.seq) fail("events must be in strictly increasing seq order");
  }
  return events;
}

export function parseInboxEvent(input: unknown): ParseResult<InboxEvent> {
  return run(() => inboxEvent(input));
}

export function parseInboxResponse(input: unknown): ParseResult<InboxResponse> {
  return run(() => {
    const obj = asObject(input, "inbox response");
    const events = eventList(obj, MAX_INBOX_EVENTS);
    const cursor = uint(obj, "cursor");
    if (events.length > 0 && events[0]!.seq <= cursor) fail("inbox events must come after the cursor");
    return { events, cursor };
  });
}

export function parseHistoryResponse(input: unknown): ParseResult<HistoryResponse> {
  return run(() => ({ events: eventList(asObject(input, "history response"), MAX_HISTORY_LIMIT) }));
}

export function parseSendResponse(input: unknown): ParseResult<SendResponse> {
  return run(() => ({ messageId: id(asObject(input, "send response"), "messageId") }));
}

export function parseHealthResponse(input: unknown): ParseResult<HealthResponse> {
  return run(() => {
    const obj = asObject(input, "health response");
    const consumersRaw = obj.consumers;
    if (!Array.isArray(consumersRaw)) fail("consumers must be an array");
    const consumers = consumersRaw.map((c): ConsumerStatus => {
      const co = asObject(c, "consumer");
      const name = str(co, "name");
      if (!CONSUMER.test(name)) fail("consumer name must match [A-Za-z0-9_-]{1,64}");
      return {
        name,
        cursor: uint(co, "cursor"),
        leaseExpiresAt: co.leaseExpiresAt === null ? null : isoTime(co, "leaseExpiresAt"),
      };
    });
    return {
      gateway: oneOf(obj, "gateway", ["connected", "reconnecting", "fatal"] as const),
      botUserId: obj.botUserId === null ? null : id(obj, "botUserId"),
      lastSeq: uint(obj, "lastSeq"),
      consumers,
    };
  });
}
