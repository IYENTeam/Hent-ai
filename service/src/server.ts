import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ServiceDatabase } from "./db.js";
import { channelIdFromHookBody, finalResponseRequestFromBody, mediaResponseForChannel } from "./final-response-routes.js";
import { createFinalResponseUseCase } from "./final-response-use-case.js";
import { ServiceDatabaseSemanticAssetRepository } from "./semantic-assets/db-repository.js";
import type { SemanticAssetRouter } from "./semantic-assets/ports.js";
import { DeterministicSemanticAssetRouter } from "./semantic-assets/router.js";
import { MAX_NATIVE_ASSET_BYTES, NativeAssetError, registerNativeAsset } from "./native-assets.js";

export type CronEnabledChannelResponse = {
  channelId: string;
  profileId: string | null;
  assetSetId: string | null;
  updatedAt: string | null;
};

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
  semanticAssetRouter?: SemanticAssetRouter;
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

export class PayloadTooLargeError extends Error {}

/** POST /v1/assets carries a base64 image, so every body is capped at the image limit. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_NATIVE_ASSET_BYTES) {
      // Keep draining with nothing buffered: the rejected request still gets its 413.
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (overflow) throw new PayloadTooLargeError(`Request body is larger than ${MAX_NATIVE_ASSET_BYTES} bytes`);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function serveStatic(db: ServiceDatabase, assetRoot: string | undefined, pathname: string, res: ServerResponse): boolean {
  if (!assetRoot || !pathname.startsWith("/static/")) return false;
  const key = decodeURIComponent(pathname.slice("/static/".length));
  const normalized = normalize(key);
  if (normalized.startsWith("..") || normalized.startsWith("/") || normalized === ".") return false;
  const object = db.db.prepare("SELECT content_type FROM storage_objects WHERE storage_key = ? AND object_url = ?")
    .get(normalized, `/static/${normalized.split("/").map(encodeURIComponent).join("/")}`) as { content_type: string } | undefined;
  if (!object || !object.content_type.startsWith("image/")) return false;
  const path = join(assetRoot, normalized);
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  res.writeHead(200, { "content-type": object.content_type, "content-length": bytes.length });
  res.end(bytes);
  return true;
}

export function createHentAiHandler(options: HentAiServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const semanticAssetRouter = options.semanticAssetRouter
    ?? new DeterministicSemanticAssetRouter(new ServiceDatabaseSemanticAssetRepository(options.db));
  const finalResponseUseCase = createFinalResponseUseCase({ db: options.db, assetRouter: semanticAssetRouter });
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "@hent-ai/service" });
        return;
      }
      if (req.method === "GET" && serveStatic(options.db, options.assetRoot, url.pathname, res)) return;
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
        const result = await finalResponseUseCase.execute(finalResponseRequestFromBody(body));
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
      if (req.method === "GET" && url.pathname === "/v1/channels") {
        sendJson(res, 200, { channels: options.db.listChannelSettings() });
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
      if (req.method === "POST" && url.pathname === "/v1/assets") {
        if (!options.assetRoot) {
          sendJson(res, 503, { error: "asset_storage_unavailable" });
          return;
        }
        const result = registerNativeAsset(options.db, options.assetRoot, await readJsonBody(req));
        sendJson(res, result.status, result.body);
        return;
      }
      notFound(res);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return sendJson(res, 413, { error: "payload_too_large", message: error.message });
      if (error instanceof NativeAssetError) return sendJson(res, error.status, { error: "native_asset_error", message: error.message });
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
