import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ServiceDatabase } from "./db.js";
import type { FinalResponseVerifier, VerifierJudgment } from "./verifier.js";

export type ServiceConfig = {
  url: URL;
  token: string;
  disabled: boolean;
  diagnostics: string[];
};

export type HentAiServerOptions = {
  db: ServiceDatabase;
  token: string;
  assetRoot?: string;
  verifier: FinalResponseVerifier;
};

export function redactBearerToken(value: string): string {
  if (!value) return "<missing>";
  return value.length <= 8 ? "<redacted>" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const diagnostics: string[] = [];
  const rawUrl = env.HENT_AI_SERVICE_URL ?? "http://127.0.0.1:8787";
  const token = env.HENT_AI_SERVICE_TOKEN ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    url = new URL("http://127.0.0.1:8787");
    diagnostics.push("Invalid HENT_AI_SERVICE_URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!local && url.protocol !== "https:") diagnostics.push("Non-local Hent-ai service URLs must use HTTPS");
  if (!token) diagnostics.push("Missing HENT_AI_SERVICE_TOKEN");
  return { url, token, disabled: diagnostics.length > 0, diagnostics };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: "unauthorized" });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { error: "bad_request", message });
}

function authorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

type ServiceMediaResponse = {
  media: {
    filename: string;
    contentType: string;
    url: string;
    sensitiveMedia: true;
    metadata: { storageKey: string };
  } | null;
  diagnostics?: Array<{ skipped: true; reason: string }>;
};

function mediaResponseForChannel(db: ServiceDatabase, channelId: string | undefined): ServiceMediaResponse {
  if (!channelId) return { media: null, diagnostics: [{ skipped: true, reason: "missing_channel_id" }] };
  const asset = db.firstAssetForChannel(channelId);
  if (!asset) return { media: null, diagnostics: [{ skipped: true, reason: "no_policy_result" }] };
  return {
    media: {
      filename: asset.filename,
      contentType: asset.contentType,
      url: asset.objectUrl,
      sensitiveMedia: true,
      metadata: { storageKey: asset.storageKey },
    },
  };
}

type FinalVerdict = {
  emotion: string;
  confidence?: number;
  reason?: string;
  media?: ServiceMediaResponse["media"];
};

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function finalResponseTextFromBody(body: unknown): string | undefined {
  const record = readBodyRecord(body);
  const context = readBodyRecord(record.context);
  return stringField(record.finalText) ?? stringField(record.content) ?? stringField(record.text)
    ?? stringField(context.finalText) ?? stringField(context.content) ?? stringField(context.text);
}

function validEmotionsFromBody(body: unknown): string[] {
  const record = readBodyRecord(body);
  const context = readBodyRecord(record.context);
  const value = Array.isArray(record.validEmotions) ? record.validEmotions : context.validEmotions;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().toLowerCase()))];
}


function mediaResponseForChannelEmotion(db: ServiceDatabase, channelId: string | undefined, emotion: string): ServiceMediaResponse["media"] {
  if (!channelId) return null;
  const mapping = db.getChannelMapping(channelId);
  if (!mapping || mapping.enabled === false || !mapping.assetSetId) return null;
  const row = db.db.prepare(`SELECT a.filename, o.content_type, o.object_url, o.storage_key
    FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id
    WHERE a.asset_set_id = ? AND lower(a.emotion) = ? ORDER BY a.filename LIMIT 1`).get(mapping.assetSetId, emotion.toLowerCase()) as Record<string, unknown> | undefined;
  return row ? {
    filename: String(row.filename),
    contentType: String(row.content_type),
    url: String(row.object_url),
    sensitiveMedia: true,
    metadata: { storageKey: String(row.storage_key) },
  } : null;
}

function validEmotionsForChannel(db: ServiceDatabase, channelId: string | undefined): string[] {
  if (!channelId) return [];
  const mapping = db.getChannelMapping(channelId);
  if (!mapping || mapping.enabled === false || !mapping.assetSetId) return [];
  return db.db.prepare("SELECT DISTINCT lower(emotion) AS emotion FROM assets WHERE asset_set_id = ? ORDER BY emotion")
    .all(mapping.assetSetId)
    .map((row) => String((row as { emotion: string }).emotion));
}

function verdictCacheKey(channelId: string | undefined, finalText: string, validEmotions: string[]): string {
  return createHash("sha256").update(JSON.stringify({ channelId: channelId ?? null, finalText, validEmotions })).digest("hex");
}

function cachedVerdict(db: ServiceDatabase, key: string, validEmotions: string[]): FinalVerdict | null | undefined {
  const row = db.db.prepare("SELECT verdict_json FROM verifier_cache WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)").get(key, new Date().toISOString()) as { verdict_json: string } | undefined;
  if (!row) return undefined;
  const verdict = JSON.parse(row.verdict_json) as FinalVerdict | null;
  if (verdict && !validEmotions.includes(verdict.emotion)) return null;
  return verdict;
}

function storeCachedVerdict(db: ServiceDatabase, key: string, verdict: FinalVerdict | null): void {
  const stamp = new Date().toISOString();
  db.db.prepare(`INSERT INTO verifier_cache (cache_key, verdict_json, expires_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET verdict_json = excluded.verdict_json, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(verdict), stamp, stamp);
}

type FinalVerdictResult = {
  verdict: FinalVerdict | null;
  diagnostics?: Array<{ skipped: true; reason: string }>;
};

function skippedVerdict(reason: string): FinalVerdictResult {
  return { verdict: null, diagnostics: [{ skipped: true, reason }] };
}

async function finalVerdictForBody(db: ServiceDatabase, verifier: FinalResponseVerifier, body: unknown): Promise<FinalVerdictResult> {
  const channelId = channelIdFromHookBody(body);
  const finalText = finalResponseTextFromBody(body);
  const explicitValidEmotions = validEmotionsFromBody(body);
  const validEmotions = explicitValidEmotions.length ? explicitValidEmotions : validEmotionsForChannel(db, channelId);
  if (!finalText || validEmotions.length === 0) return skippedVerdict("no_final_text_or_valid_emotions");

  const key = verdictCacheKey(channelId, finalText, validEmotions);
  const cached = cachedVerdict(db, key, validEmotions);
  if (cached !== undefined) {
    if (!cached) return skippedVerdict("cached_null_verdict");
    const media = mediaResponseForChannelEmotion(db, channelId, cached.emotion);
    return media ? { verdict: { ...cached, media } } : skippedVerdict("no_asset_for_emotion");
  }

  let selected: VerifierJudgment | null;
  try {
    selected = await verifier.verify({ channelId, finalText, validEmotions });
  } catch (error) {
    console.warn(`[hent-ai-service] verifier error channelId=${channelId ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`);
    return skippedVerdict("verifier_error");
  }

  const emotion = typeof selected?.emotion === "string" ? selected.emotion.trim().toLowerCase() : undefined;
  if (!selected || !emotion || !validEmotions.includes(emotion)) {
    storeCachedVerdict(db, key, null);
    return skippedVerdict("verifier_emotion_invalid");
  }

  const media = mediaResponseForChannelEmotion(db, channelId, emotion);
  if (!media) {
    storeCachedVerdict(db, key, null);
    return skippedVerdict("no_asset_for_emotion");
  }

  const verdict: FinalVerdict = { ...selected, emotion, media };
  storeCachedVerdict(db, key, verdict);
  return { verdict };
}

function channelIdFromHookBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { channelId?: unknown; context?: { channelId?: unknown } };
  const channelId = record.context?.channelId ?? record.channelId;
  return typeof channelId === "string" && channelId.trim() ? channelId.trim() : undefined;
}

type CommunityConversationMessage = {
  authorId?: string;
  content: string;
  createdAt?: string;
};

type CommunityGenerateRequest = {
  communitySelector?: {
    conversationWindow: CommunityConversationMessage[];
    draftReply: string;
    channelId: string;
    profileId: string;
    assetSetId: string;
  };
};

type CronEnabledChannelResponse = {
  channelId: string;
  profileId: string | null;
  assetSetId: string | null;
  updatedAt: string | null;
};

function parseConversationWindow(value: unknown): CommunityConversationMessage[] {
  if (!Array.isArray(value)) throw new Error("communitySelector.conversationWindow must be an array");
  return value.map((item) => {
    const record = readBodyRecord(item);
    const content = stringField(record.content);
    if (!content) throw new Error("communitySelector.conversationWindow[*].content is required");
    return {
      authorId: stringField(record.authorId),
      content,
      createdAt: stringField(record.createdAt),
    };
  });
}

function validateCommunityGenerateRequest(body: unknown): CommunityGenerateRequest {
  const record = readBodyRecord(body);
  const selector = readBodyRecord(record.communitySelector);
  if (!record.communitySelector && !selector.channelId && !selector.draftReply) return record as CommunityGenerateRequest;

  const channelId = stringField(selector.channelId);
  const draftReply = stringField(selector.draftReply);
  const profileId = stringField(selector.profileId);
  const assetSetId = stringField(selector.assetSetId);
  if (!channelId) throw new Error("communitySelector.channelId is required");
  if (!draftReply) throw new Error("communitySelector.draftReply is required");
  if (!profileId) throw new Error("communitySelector.profileId is required");
  if (!assetSetId) throw new Error("communitySelector.assetSetId is required");
  return {
    ...record,
    communitySelector: {
      conversationWindow: parseConversationWindow(selector.conversationWindow),
      draftReply,
      channelId,
      profileId,
      assetSetId,
    },
  };
}

function serializeJob(job: NonNullable<ReturnType<ServiceDatabase["getGenerationJob"]>>): unknown {
  return {
    jobId: job.id,
    id: job.id,
    status: job.status,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function serveStatic(assetRoot: string | undefined, pathname: string, res: ServerResponse): boolean {
  if (!assetRoot || !pathname.startsWith("/static/")) return false;
  const key = decodeURIComponent(pathname.slice("/static/".length));
  const normalized = normalize(key);
  if (normalized.startsWith("..")) return false;
  const path = join(assetRoot, normalized);
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  const contentType = path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : path.endsWith(".webp") ? "image/webp" : "application/octet-stream";
  res.writeHead(200, { "content-type": contentType, "content-length": bytes.length });
  res.end(bytes);
  return true;
}

export function createHentAiHandler(options: HentAiServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "@hent-ai/service" });
        return;
      }
      if (req.method === "GET" && serveStatic(options.assetRoot, url.pathname, res)) return;
      if (url.pathname.startsWith("/v1/") && !authorized(req, options.token)) {
        unauthorized(res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/pre-reply/media") {
        const body = await readJsonBody(req);
        sendJson(res, 200, mediaResponseForChannel(options.db, channelIdFromHookBody(body)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/final-response/verdict") {
        const body = await readJsonBody(req);
        const result = await finalVerdictForBody(options.db, options.verifier, body);
        sendJson(res, 200, { verdict: result.verdict, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/profiles") {
        sendJson(res, 200, { profiles: options.db.listProfiles() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/profiles") {
        const body = await readJsonBody(req) as Parameters<ServiceDatabase["createProfile"]>[0];
        sendJson(res, 201, { profile: options.db.createProfile(body) });
        return;
      }
      const profileMatch = url.pathname.match(/^\/v1\/profiles\/([^/]+)$/);
      if (profileMatch && req.method === "GET") {
        const profile = options.db.getProfile(decodeURIComponent(profileMatch[1]!));
        if (!profile) return notFound(res);
        sendJson(res, 200, { profile });
        return;
      }
      if (profileMatch && req.method === "PATCH") {
        const body = await readJsonBody(req) as Parameters<ServiceDatabase["updateProfile"]>[1];
        sendJson(res, 200, { profile: options.db.updateProfile(decodeURIComponent(profileMatch[1]!), body) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/channels/cron-enabled") {
        sendJson(res, 200, {
          revision: options.db.cronEnabledRevision(),
          channels: options.db.listCronEnabledChannels() as CronEnabledChannelResponse[],
        });
        return;
      }
      const channelMatch = url.pathname.match(/^\/v1\/channels\/([^/]+)\/mapping$/);
      if (channelMatch && req.method === "GET") {
        sendJson(res, 200, { mapping: options.db.getChannelMapping(decodeURIComponent(channelMatch[1]!)) });
        return;
      }
      if (channelMatch && req.method === "PUT") {
        const body = await readJsonBody(req) as Parameters<ServiceDatabase["setChannelMapping"]>[1];
        sendJson(res, 200, { mapping: options.db.setChannelMapping(decodeURIComponent(channelMatch[1]!), body) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/assets/generate") {
        const body = validateCommunityGenerateRequest(await readJsonBody(req));
        const job = options.db.createGenerationJob(body);
        sendJson(res, 202, { jobId: job.id });
        return;
      }
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === "GET") {
        const job = options.db.getGenerationJob(decodeURIComponent(jobMatch[1]!));
        if (!job) return notFound(res);
        sendJson(res, 200, serializeJob(job));
        return;
      }
      notFound(res);
    } catch (error) {
      if (error instanceof SyntaxError) return badRequest(res, "Invalid JSON body");
      if (error instanceof Error && (error.message.includes("not found") || error.message.includes("required") || error.message.includes("Invalid"))) return badRequest(res, error.message);
      sendJson(res, 500, { error: "internal_error" });
    }
  };
}

export function createHentAiServer(options: HentAiServerOptions): Server {
  return createServer((req, res) => { void createHentAiHandler(options)(req, res); });
}

export async function listen(server: Server, port = 0, hostname = "127.0.0.1"): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(port, hostname, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP address");
  return {
    url: `http://${address.address}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
