import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export type HentAiServiceConfig = {
  url?: string;
  token?: string;
  timeoutMs?: number;
};

export type ServiceDiagnostics = Array<Record<string, unknown>>;

export type OpenClawStage1Media = {
  mediaUrl: string;
  mediaUrls?: string[];
  caption?: string;
  sensitiveMedia?: boolean;
  channelData?: Record<string, unknown>;
  contentType?: string;
};

export type MediaHookResult = {
  media: OpenClawStage1Media | null;
  diagnostics: ServiceDiagnostics;
};

export type ReplyPayloadHookResult = {
  payload?: Record<string, unknown>;
  diagnostics?: ServiceDiagnostics;
};

type RuntimeConfigProvider = {
  config?: {
    current?: () => unknown;
  };
};
type HookContext = {
  channelId?: unknown;
  conversationId?: unknown;
  accountId?: unknown;
  messageId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
};

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 5_000;
const MEDIA_CACHE_DIR = join(homedir(), ".openclaw", "media", "hent-ai-service-adapter");
const TOKEN_PLACEHOLDER_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function loggerInfo(logger: Logger | undefined, message: string): void {
  logger?.info?.(message);
}

function loggerWarn(logger: Logger | undefined, message: string): void {
  logger?.warn?.(message);
}

export function expandEnvPlaceholder(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = TOKEN_PLACEHOLDER_RE.exec(value);
  if (!match) return value;
  return process.env[match[1]];
}

export function normalizeDiscordChannelId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("channel:") ? trimmed.slice("channel:".length) : trimmed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function isLocalhostUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

export function validateServiceConfig(config: HentAiServiceConfig | undefined):
  | { ok: true; baseUrl: URL; token: string; timeoutMs: number }
  | { ok: false; reason: string } {
  const urlValue = typeof config?.url === "string" ? config.url.trim() : "";
  if (!urlValue) return { ok: false, reason: "missing hentAiService.url" };

  let baseUrl: URL;
  try {
    baseUrl = new URL(urlValue);
  } catch {
    return { ok: false, reason: "invalid hentAiService.url" };
  }

  if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && isLocalhostUrl(baseUrl))) {
    return { ok: false, reason: "hentAiService.url must be HTTPS unless it targets localhost" };
  }

  const token = expandEnvPlaceholder(config?.token)?.trim();
  if (!token) return { ok: false, reason: "missing hentAiService.token" };

  return {
    ok: true,
    baseUrl,
    token,
    timeoutMs: numberOrDefault(config?.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

function configFromRuntime(runtime?: RuntimeConfigProvider): HentAiServiceConfig | undefined {
  const current = runtime?.config?.current?.();
  const record = asRecord(current);
  const namespace = asRecord(record?.hentAiService);
  return namespace ? namespace as HentAiServiceConfig : undefined;
}

export function resolveServiceConfig(api: { pluginConfig?: unknown; runtime?: RuntimeConfigProvider }): HentAiServiceConfig | undefined {
  const pluginConfig = asRecord(api.pluginConfig);
  const pluginNamespace = asRecord(pluginConfig?.hentAiService);
  if (pluginNamespace) return pluginNamespace as HentAiServiceConfig;
  return configFromRuntime(api.runtime);
}

function endpointUrl(baseUrl: URL, endpoint: string): string {
  const url = new URL(baseUrl.toString());
  url.pathname = `${url.pathname.replace(/\/$/, "")}${endpoint}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function diagnostic(reason: string, extra?: Record<string, unknown>): ServiceDiagnostics {
  return [{ reason, skipped: true, sourcePluginId: "hent-ai", ...extra }];
}

function dataUrlFromBase64(dataBase64: string, contentType: string): string {
  return `data:${contentType};base64,${dataBase64}`;
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "png";
}

export function normalizeServiceMedia(value: unknown): OpenClawStage1Media | null {
  const media = asRecord(value);
  if (!media) return null;

  const url = typeof media.url === "string" && media.url.trim()
    ? media.url.trim()
    : typeof media.mediaUrl === "string" && media.mediaUrl.trim()
      ? media.mediaUrl.trim()
      : undefined;
  const contentType = typeof media.contentType === "string" && media.contentType.trim()
    ? media.contentType.trim()
    : "image/png";
  const dataBase64 = typeof media.dataBase64 === "string" && media.dataBase64.trim()
    ? media.dataBase64.trim()
    : undefined;
  const mediaUrl = url ?? (dataBase64 ? dataUrlFromBase64(dataBase64, contentType) : undefined);
  if (!mediaUrl) return null;

  const mediaUrls = Array.isArray(media.mediaUrls)
    ? media.mediaUrls.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : undefined;

  const result: OpenClawStage1Media = { mediaUrl };
  if (mediaUrls?.length) result.mediaUrls = mediaUrls;
  if (typeof media.caption === "string") result.caption = media.caption;
  if (typeof media.sensitiveMedia === "boolean") result.sensitiveMedia = media.sensitiveMedia;
  if (asRecord(media.channelData)) result.channelData = media.channelData as Record<string, unknown>;
  if (contentType) result.contentType = contentType;
  return result;
}

async function saveServiceMediaBuffer(buffer: Buffer, contentType: string): Promise<string> {
  await mkdir(MEDIA_CACHE_DIR, { recursive: true });
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const path = join(MEDIA_CACHE_DIR, `${digest}.${extensionForContentType(contentType)}`);
  await writeFile(path, buffer);
  return path;
}

async function hydrateLocalServiceMedia(media: OpenClawStage1Media, baseUrl: URL, fetchImpl: FetchLike): Promise<OpenClawStage1Media> {
  const mediaUrl = new URL(media.mediaUrl, baseUrl);
  if (mediaUrl.origin !== baseUrl.origin) return media;

  const response = await fetchImpl(mediaUrl, { method: "GET" });
  if (!response.ok) throw new Error(`media fetch returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? media.contentType ?? "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { ...media, mediaUrl: await saveServiceMediaBuffer(buffer, contentType), contentType };
}

async function callHentAiService(params: {
  baseUrl: URL;
  token: string;
  timeoutMs: number;
  endpoint: string;
  body: unknown;
  responseMediaPath: "media" | "verdict.media";
  logger?: Logger;
  fetchImpl?: FetchLike;
}): Promise<MediaHookResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;

  try {
    loggerInfo(params.logger, `hent-ai adapter: calling service endpoint=${params.endpoint}`);
    const response = await fetchImpl(endpointUrl(params.baseUrl, params.endpoint), {
      method: "POST",
      headers: {
        "authorization": `Bearer ${params.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const reason = `service returned HTTP ${response.status}`;
      loggerWarn(params.logger, `hent-ai adapter: ${reason}; skipping media`);
      return { media: null, diagnostics: diagnostic(reason, { status: response.status }) };
    }

    const payload = await response.json() as unknown;
    if (payload === null) {
      loggerWarn(params.logger, "hent-ai adapter: service returned null; skipping media");
      return { media: null, diagnostics: diagnostic("service returned null") };
    }

    const root = asRecord(payload);
    const mediaValue = params.responseMediaPath === "media"
      ? root?.media
      : asRecord(root?.verdict)?.media;
    const media = normalizeServiceMedia(mediaValue);
    if (!media) {
      loggerWarn(params.logger, "hent-ai adapter: service media missing or malformed; skipping media");
      return { media: null, diagnostics: diagnostic("service media missing or malformed") };
    }
    const hydratedMedia = await hydrateLocalServiceMedia(media, params.baseUrl, fetchImpl);

    loggerInfo(params.logger, `hent-ai adapter: service returned media endpoint=${params.endpoint}`);
    const diagnostics = Array.isArray(root?.diagnostics)
      ? root.diagnostics.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
      : [];
    return { media: hydratedMedia, diagnostics };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? "service request timed out"
      : `service request failed: ${error instanceof Error ? error.message : String(error)}`;
    loggerWarn(params.logger, `hent-ai adapter: ${reason}; skipping media`);
    return { media: null, diagnostics: diagnostic(reason) };
  } finally {
    clearTimeout(timeout);
  }
}

function contextRecord(ctx: unknown): HookContext {
  return (asRecord(ctx) ?? {}) as HookContext;
}

function replyPayloadBody(event: unknown, ctx?: unknown): Record<string, unknown> {
  const record = asRecord(event) ?? {};
  const hookCtx = contextRecord(ctx);
  const payload = asRecord(record.payload) ?? {};
  const to = stringValue(record.to) ?? stringValue(payload.to);
  const channelId = normalizeDiscordChannelId(
    stringValue(record.channelId) ?? stringValue(hookCtx.conversationId) ?? to ?? stringValue(hookCtx.channelId),
  );
  return {
    context: {
      to,
      channelId,
      finalText: payload.text ?? record.content ?? record.finalText,
      text: payload.text,
      kind: record.kind,
      metadata: record.metadata,
      sessionKey: record.sessionKey ?? hookCtx.sessionKey,
      runId: record.runId ?? hookCtx.runId,
    },
  };
}

function mergeMediaIntoPayload(payload: unknown, media: OpenClawStage1Media | null): Record<string, unknown> | undefined {
  if (!media) return undefined;
  const current = asRecord(payload) ?? {};
  const merged: Record<string, unknown> = { ...current };

  const mediaUrls = [
    ...(
      Array.isArray(current.mediaUrls)
        ? current.mediaUrls.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : []
    ),
    ...(
      typeof current.mediaUrl === "string" && current.mediaUrl.trim()
        ? [current.mediaUrl.trim()]
        : []
    ),
    media.mediaUrl,
    ...(media.mediaUrls ?? []),
  ];

  const uniqueMediaUrls = [...new Set(mediaUrls)];
  delete merged.mediaUrl;
  if (uniqueMediaUrls.length === 1) {
    merged.mediaUrl = uniqueMediaUrls[0];
  } else if (uniqueMediaUrls.length > 1) {
    merged.mediaUrls = uniqueMediaUrls;
  }
  if (media.sensitiveMedia !== undefined) merged.sensitiveMedia = media.sensitiveMedia;
  if (media.channelData) merged.channelData = { ...(asRecord(current.channelData) ?? {}), ...media.channelData };
  return merged;
}

export default definePluginEntry({
  id: "hent-ai-service-adapter",
  name: "Hent-ai Service Adapter",
  description: "Delegates OpenClaw media lifecycle hooks to the Hent-ai service.",

  register(api: any) {
    const pluginConfig = asRecord(api.pluginConfig);
    if (pluginConfig?.enabled === false) {
      loggerInfo(api.logger, "hent-ai adapter disabled: enabled=false");
      return;
    }
    const config = validateServiceConfig(resolveServiceConfig(api));
    if (!config.ok) {
      loggerWarn(api.logger, `hent-ai adapter disabled: ${config.reason}`);
      return;
    }

    loggerInfo(api.logger, `hent-ai adapter enabled: url=${config.baseUrl.origin} timeoutMs=${config.timeoutMs}`);

    api.on("reply_payload_sending", async (event: unknown, ctx: unknown): Promise<ReplyPayloadHookResult> => {
      const result = await callHentAiService({
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs: config.timeoutMs,
        endpoint: "/v1/final-response/verdict",
        body: replyPayloadBody(event, ctx),
        responseMediaPath: "verdict.media",
        logger: api.logger,
      });
      const payload = mergeMediaIntoPayload(asRecord(event)?.payload, result.media);
      return payload ? { payload, diagnostics: result.diagnostics } : { diagnostics: result.diagnostics };
    }, { name: "hent-ai-reply-payload-media" });
  },
});
