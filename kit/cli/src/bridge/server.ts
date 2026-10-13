// Bridge local API (ADR-0002 "Local API"): Bun.serve on 127.0.0.1, bearer auth from
// bridge.secret on every route except /v1/health, strict request parsing via contract.ts.

import { timingSafeEqual } from "node:crypto";
import type { Discord } from "../messenger/discord.ts";
import { MessengerError } from "../messenger/http.ts";
import type { Clock } from "../run.ts";
import {
  advanceCursor,
  BRIDGE_ROUTES,
  type BridgeError,
  type BridgeErrorCode,
  type GatewayState,
  type HealthResponse,
  type InboxEvent,
  MAX_INBOX_EVENTS,
  MAX_SEND_FILE_BYTES,
  type MultipartSendRequest,
  parseEditRequest,
  parseHandledRequest,
  parseHistoryQuery,
  parseInboxQuery,
  parseSendMultipart,
  parseSendRequest,
  parseSessionRequest,
  parseTypingRequest,
  type ParseResult,
  type SendRequest,
  type SessionRequest,
} from "./contract.ts";
import { type BridgeLog, type ConsumerStore, type HandledLedger, type Journal, type SentLedger, writePrivateFile } from "./journal.ts";

/**
 * Extension points for later todos. `onJournaled` fires once per newly journaled event in seq
 * order (push delivery, todo 9 `deliver.ts`); `onSessionSet` fires after POST /v1/session wrote
 * session.json (todo 9 re-injects pending-handling events there).
 */
export type BridgeHooks = {
  readonly onJournaled?: (event: InboxEvent) => void;
  readonly onSessionSet?: (session: SessionRequest) => void;
};

export type BridgeServerDeps = {
  readonly port: number;
  readonly secret: string;
  readonly journal: Journal;
  readonly consumers: ConsumerStore;
  readonly sent: SentLedger;
  readonly handled: HandledLedger;
  readonly sessionPath: string;
  readonly status: () => { gateway: GatewayState; botUserId: string | null };
  readonly discord: () => Discord | null;
  readonly clock: Clock;
  readonly log: BridgeLog;
  readonly hooks: BridgeHooks;
  /** Window for retrying an ambiguous Discord outcome (timeout/5xx) with the same nonce. */
  readonly sendRetryWindowMs?: number;
  readonly sendRetryDelayMs?: number;
};

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const fail = (status: number, error: BridgeErrorCode, message: string): Response => json({ error, message } satisfies BridgeError, status);
const invalid = (message: string): Response => fail(400, "invalid_request", message);

const readJson = async (req: Request): Promise<ParseResult<unknown>> => {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false, error: "body is not valid JSON" };
  }
};

const authorized = (req: Request, secret: string): boolean => {
  const header = req.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const isAmbiguous = (error: unknown): boolean => !(error instanceof MessengerError) || error.status >= 500 || error.status === 429;

export const startBridgeServer = (deps: BridgeServerDeps) => {
  const { journal, consumers, sent, handled, clock, log } = deps;
  const inflightPolls = new Map<string, AbortController>();
  const inflightSends = new Map<string, Promise<string>>();
  const retryWindow = deps.sendRetryWindowMs ?? 60_000;
  const retryDelay = deps.sendRetryDelayMs ?? 2_000;

  const markHandled = (messageId: string, how: "replied" | "skipped"): void => {
    if (handled.mark({ messageId, how, at: new Date(clock.now()).toISOString() })) log("BRIDGE_HANDLED", { messageId, how });
  };

  const withAmbiguityRetry = async (op: () => Promise<string>): Promise<string> => {
    const deadline = clock.now() + retryWindow;
    for (;;) {
      try {
        return await op();
      } catch (error) {
        if (!isAmbiguous(error) || clock.now() >= deadline) throw error;
        log("BRIDGE_SEND_RETRY", { status: error instanceof MessengerError ? error.status : null });
        await clock.sleep(retryDelay);
      }
    }
  };

  const inbox = async (req: Request, params: URLSearchParams): Promise<Response> => {
    const parsed = parseInboxQuery(params);
    if (!parsed.ok) return invalid(parsed.error);
    const q = parsed.value;
    // The query carries no holder id, so the lease holder is the in-flight long-poll for this consumer.
    const holder = inflightPolls.get(q.consumer);
    if (holder && !q.takeover) return fail(409, "lease_held", `consumer ${q.consumer} is held by another poll`);
    holder?.abort();
    const controller = new AbortController();
    inflightPolls.set(q.consumer, controller);
    try {
      const before = consumers.cursor(q.consumer);
      const cursor = advanceCursor(before, q.ack, journal.lastSeq);
      if (cursor !== before) consumers.setCursor(q.consumer, cursor);
      consumers.renewLease(q.consumer);
      let events = journal.after(cursor, MAX_INBOX_EVENTS);
      if (events.length === 0 && q.wait > 0) {
        log("BRIDGE_INBOX_WAIT", { consumer: q.consumer, waitS: q.wait });
        await journal.waitForAppend(q.wait * 1000, AbortSignal.any([controller.signal, req.signal]));
        events = journal.after(cursor, MAX_INBOX_EVENTS);
      }
      return json({ events, cursor });
    } finally {
      if (inflightPolls.get(q.consumer) === controller) inflightPolls.delete(q.consumer);
    }
  };

  const send = async (req: Request): Promise<Response> => {
    const isMultipart = (req.headers.get("content-type") ?? "").startsWith("multipart/form-data");
    let parsed: ParseResult<SendRequest | MultipartSendRequest>;
    if (isMultipart) {
      let form: FormData;
      try {
        form = (await req.formData()) as unknown as FormData;
      } catch {
        return invalid("multipart body could not be parsed");
      }
      parsed = parseSendMultipart(form);
    } else {
      const body = await readJson(req);
      parsed = body.ok ? parseSendRequest(body.value) : body;
    }
    if (!parsed.ok) return invalid(parsed.error);
    const request = parsed.value;
    const prior = sent.get(request.nonce);
    if (prior) {
      if (request.replyToMessageId) markHandled(request.replyToMessageId, "replied");
      log("BRIDGE_SEND_DEDUPED", { channelId: prior.channelId, messageId: prior.messageId });
      return json({ messageId: prior.messageId });
    }
    if (deps.status().gateway === "fatal") return fail(503, "gateway_fatal", "the gateway closed with a fatal code");
    const discord = deps.discord();
    if (!discord) return fail(502, "discord_error", "the bridge has no Discord token yet");
    const options = { nonce: request.nonce, ...(request.replyToMessageId ? { replyToMessageId: request.replyToMessageId } : {}) };
    let pending = inflightSends.get(request.nonce);
    if (!pending) {
      pending = withAmbiguityRetry(async () => {
        if ("file" in request) {
          const bytes = new Uint8Array(await request.file.data.arrayBuffer());
          return discord.sendWithFile(request.channelId, request.text, { name: request.file.name, bytes, contentType: request.file.contentType }, options);
        }
        return discord.send(request.channelId, request.text, options);
      });
      inflightSends.set(request.nonce, pending);
    }
    let messageId: string;
    try {
      messageId = await pending;
    } catch (error) {
      log("BRIDGE_SEND_FAILED", { channelId: request.channelId, status: error instanceof MessengerError ? error.status : null });
      return fail(502, "discord_error", error instanceof MessengerError ? `discord status ${error.status}` : "discord request failed");
    } finally {
      inflightSends.delete(request.nonce);
    }
    if (!sent.get(request.nonce)) sent.record({ nonce: request.nonce, messageId, channelId: request.channelId, at: new Date(clock.now()).toISOString() });
    if (request.replyToMessageId) markHandled(request.replyToMessageId, "replied");
    log("BRIDGE_SENT", { channelId: request.channelId, messageId, file: "file" in request });
    return json({ messageId });
  };

  const discordCall = async (op: (discord: Discord) => Promise<Response>): Promise<Response> => {
    if (deps.status().gateway === "fatal") return fail(503, "gateway_fatal", "the gateway closed with a fatal code");
    const discord = deps.discord();
    if (!discord) return fail(502, "discord_error", "the bridge has no Discord token yet");
    try {
      return await op(discord);
    } catch (error) {
      return fail(502, "discord_error", error instanceof MessengerError ? `discord status ${error.status}` : "discord request failed");
    }
  };

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname === BRIDGE_ROUTES.health && req.method === "GET") {
      const { gateway, botUserId } = deps.status();
      return json({ gateway, botUserId, lastSeq: journal.lastSeq, consumers: consumers.list() } satisfies HealthResponse);
    }
    if (!(Object.values(BRIDGE_ROUTES) as string[]).includes(pathname)) return new Response("not found", { status: 404 });
    if (!authorized(req, deps.secret)) return fail(401, "unauthorized", "missing or wrong bearer");
    const expected = pathname === BRIDGE_ROUTES.inbox || pathname === BRIDGE_ROUTES.history ? "GET" : "POST";
    if (req.method !== expected) return new Response("method not allowed", { status: 405, headers: { allow: expected } });

    switch (pathname) {
      case BRIDGE_ROUTES.inbox:
        return inbox(req, url.searchParams);
      case BRIDGE_ROUTES.history: {
        const parsed = parseHistoryQuery(url.searchParams);
        if (!parsed.ok) return invalid(parsed.error);
        return json({ events: journal.history(parsed.value.channelId, parsed.value.limit) });
      }
      case BRIDGE_ROUTES.send:
        return send(req);
      case BRIDGE_ROUTES.edit: {
        const body = await readJson(req);
        const parsed = body.ok ? parseEditRequest(body.value) : body;
        if (!parsed.ok) return invalid(parsed.error);
        const { channelId, messageId, text } = parsed.value;
        return discordCall(async (discord) => {
          await discord.edit(channelId, messageId, text);
          log("BRIDGE_EDITED", { channelId, messageId });
          return json({ messageId });
        });
      }
      case BRIDGE_ROUTES.typing: {
        const body = await readJson(req);
        const parsed = body.ok ? parseTypingRequest(body.value) : body;
        if (!parsed.ok) return invalid(parsed.error);
        const { channelId } = parsed.value;
        return discordCall(async (discord) => {
          await discord.typing(channelId);
          return new Response(null, { status: 204 });
        });
      }
      case BRIDGE_ROUTES.handled: {
        const body = await readJson(req);
        const parsed = body.ok ? parseHandledRequest(body.value) : body;
        if (!parsed.ok) return invalid(parsed.error);
        markHandled(parsed.value.messageId, parsed.value.how);
        return new Response(null, { status: 204 });
      }
      case BRIDGE_ROUTES.session: {
        const body = await readJson(req);
        const parsed = body.ok ? parseSessionRequest(body.value) : body;
        if (!parsed.ok) return invalid(parsed.error);
        writePrivateFile(deps.sessionPath, `${JSON.stringify({ ...parsed.value, updatedAt: new Date(clock.now()).toISOString() }, null, 2)}\n`);
        log("BRIDGE_SESSION_SET", { agent: parsed.value.agent, mode: parsed.value.mode });
        deps.hooks.onSessionSet?.(parsed.value);
        return new Response(null, { status: 204 });
      }
    }
    return new Response("not found", { status: 404 });
  };

  return Bun.serve({
    hostname: "127.0.0.1",
    port: deps.port,
    idleTimeout: 60,
    maxRequestBodySize: MAX_SEND_FILE_BYTES + 1024 * 1024,
    fetch: route,
    error: (error) => {
      log("BRIDGE_API_ERROR", { name: error.name });
      return fail(500, "invalid_request", "internal error");
    },
  });
};
