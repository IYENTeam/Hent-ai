import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ServiceDatabase } from "./db.js";
import type { FinalResponseVerifier } from "./verifier.js";
import type { ConversationContextProvider } from "./conversation-evaluate-context.js";
import { createConversationRuntime } from "./conversation-runtime.js";
import { loadConversationConfigFromEnv, type ConversationServiceConfig } from "./conversation-config.js";
import { type CronEnabledChannelResponse, serializeJob, validateCommunityGenerateRequest } from "./community-routes.js";
import { channelIdFromHookBody, finalVerdictForBody, mediaResponseForChannel } from "./final-response-routes.js";
import { handleWatcherRoute, isWatcherRoute } from "./watcher-routes.js";

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
  conversationConfig?: ConversationServiceConfig;
  conversationContextProvider?: ConversationContextProvider;
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
  const conversationRuntime = createConversationRuntime(options.db, options.conversationConfig ?? loadConversationConfigFromEnv(), {
    ...(options.conversationContextProvider ? { contextProvider: options.conversationContextProvider } : {}),
  });
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
      if (isWatcherRoute(req.method, url.pathname)) {
        const result = await handleWatcherRoute({
          method: req.method,
          pathname: url.pathname,
          body: await readJsonBody(req),
          runtime: conversationRuntime,
        });
        if (!result) return notFound(res);
        sendJson(res, result.status, result.body);
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
  const handler = createHentAiHandler(options);
  return createServer((req, res) => { void handler(req, res); });
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
