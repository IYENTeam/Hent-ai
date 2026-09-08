import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export type FeatureToggleConfig = boolean | { enabled?: boolean };

export type ConversationForwardingConfig = {
  readonly enabled?: boolean;
  readonly watcherCompatibility?: boolean;
};

export type HentAiServiceConfig = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  /** Sends media as a separate inbound/pre-reply message when explicitly enabled. */
  preReplyMedia?: FeatureToggleConfig;
  /** Enables watcher record/evaluate hooks. Intended for the separate group-chat watcher module. */
  watcher?: FeatureToggleConfig;
  conversation?: ConversationForwardingConfig;
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
  replyToBody?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
};
type ReplyPayloadSendingEvent = {
  payload?: Record<string, unknown>;
  kind?: "tool" | "block" | "final" | string;
  channel?: string;
  sessionKey?: string;
  runId?: string;
};

type OpenClawOutboundSendContext = {
  cfg: unknown;
  to: string;
  text: string;
  mediaUrl?: string;
  accountId?: string | null;
};

type OpenClawOutboundAdapter = {
  sendText?: (ctx: OpenClawOutboundSendContext) => Promise<unknown>;
  sendMedia?: (ctx: OpenClawOutboundSendContext) => Promise<unknown>;
};

type OpenClawOutboundRuntime = {
  channel?: {
    outbound?: {
      loadAdapter?: (id: string) => Promise<OpenClawOutboundAdapter | undefined>;
    };
  };
};

type PluginApi = {
  pluginConfig?: unknown;
  config?: unknown;
  runtime?: RuntimeConfigProvider & OpenClawOutboundRuntime;
  logger?: Logger;
  on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown, options?: { name?: string }) => void;
  supportsHook?: (name: string) => boolean;
};

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type FetchLike = typeof fetch;

export type OpenClawOutboundTarget = {
  /** OpenClaw channel adapter id, for example `discord` or an injected `loopback`. */
  channel: string;
  /** Host-native delivery target copied from the hook event/context. */
  to: string;
  accountId?: string;
};

export type OpenClawMessageSender = {
  sendText?: (target: OpenClawOutboundTarget, text: string) => Promise<string | null>;
  sendMedia?: (target: OpenClawOutboundTarget, mediaUrl: string, text?: string) => Promise<string | null>;
};

type ConversationDeliveryChunkMetadata = {
  readonly hentAiConversationChunk: true;
  readonly planId: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
};

type ConversationDeliveryChunk = {
  readonly chunkId: string;
  readonly text: string;
  readonly delayMs: number;
  readonly metadata: ConversationDeliveryChunkMetadata;
};

type ConversationDeliveryPlan = {
  readonly dispatch?: {
    readonly claimId: string;
    readonly expiresAtMs: number;
    readonly deliveryMessageIds: Readonly<Record<string, string>>;
  };
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly chunks: readonly ConversationDeliveryChunk[];
  readonly commit: {
    readonly planId: string;
    readonly cooldownKey: string;
    readonly signalId: string;
    readonly requiredChunkIds: readonly string[];
  };
};

type MessageSentServiceResponse = {
  readonly deliveryPlan?: ConversationDeliveryPlan;
  readonly nudgeText?: string;
  readonly audit?: unknown;
};

function extractOutboundMessageId(result: unknown): string | null {
  const record = asRecord(result);
  if (typeof record?.messageId === "string") return record.messageId;
  const nested = asRecord(record?.result);
  return typeof nested?.messageId === "string" ? nested.messageId : null;
}

export function createOpenClawMessageSender(api: {
  config?: unknown;
  runtime?: OpenClawOutboundRuntime;
  logger?: Logger;
}): OpenClawMessageSender | undefined {
  const loadAdapter = api.runtime?.channel?.outbound?.loadAdapter;
  if (!loadAdapter) return undefined;
  return {
    async sendText(target, text) {
      try {
        const adapter = await loadAdapter(target.channel);
        if (!adapter?.sendText) return null;
        const result = await adapter.sendText({
          cfg: api.config ?? {},
          to: target.to,
          text,
          ...(target.accountId ? { accountId: target.accountId } : {}),
        });
        return extractOutboundMessageId(result);
      } catch (error) {
        loggerWarn(api.logger, `hent-ai adapter: outbound text send failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    async sendMedia(target, mediaUrl, text = "") {
      try {
        const adapter = await loadAdapter(target.channel);
        if (!adapter?.sendMedia) return null;
        const result = await adapter.sendMedia({
          cfg: api.config ?? {},
          to: target.to,
          text,
          mediaUrl,
          ...(target.accountId ? { accountId: target.accountId } : {}),
        });
        return extractOutboundMessageId(result);
      } catch (error) {
        loggerWarn(api.logger, `hent-ai adapter: outbound media send failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MEDIA_CACHE_DIR = join(homedir(), ".openclaw", "media", "hent-ai-service-adapter");
const TOKEN_PLACEHOLDER_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/i;
const COMMUNITY_CRON_POLL_INTERVAL_MS = 1_000;

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

function featureEnabled(value: FeatureToggleConfig | undefined, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  const record = asRecord(value);
  if (typeof record?.enabled === "boolean") return record.enabled;
  return fallback;
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
      // The service answers `media: null` / `verdict: null` (with diagnostics)
      // when it intentionally has nothing to attach — unmapped channel, null
      // verdict, etc. Only an answer that lacks those keys is malformed.
      const explicitSkip = params.responseMediaPath === "media"
        ? root !== null && "media" in root && root.media === null
        : root !== null && "verdict" in root && root.verdict === null;
      const reasons = Array.isArray(root?.diagnostics)
        ? root.diagnostics.map((entry) => asRecord(entry)?.reason).filter((reason): reason is string => typeof reason === "string")
        : [];
      const detail = reasons.length ? ` (${reasons.join(", ")})` : "";
      if (explicitSkip) {
        const isServiceError = reasons.some((reason) => reason.includes("error"));
        const message = `hent-ai adapter: service returned no media; skipping${detail}`;
        if (isServiceError) loggerWarn(params.logger, message);
        else loggerInfo(params.logger, message);
        return { media: null, diagnostics: diagnostic(reasons[0] ?? "service returned no media") };
      }
      loggerWarn(params.logger, `hent-ai adapter: service media missing or malformed; skipping media${detail}`);
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

function messageSentBody(event: unknown, ctx?: unknown): Record<string, unknown> {
  const record = asRecord(event) ?? {};
  const payload = asRecord(record.payload);
  const hookCtx = contextRecord(ctx);
  const to = stringValue(record.to) ?? stringValue(payload?.to);
  const channelId = normalizeDiscordChannelId(
    stringValue(record.channelId)
      ?? stringValue(hookCtx.conversationId)
      ?? to
      ?? stringValue(hookCtx.channelId),
  );
  return {
    context: {
      to,
      channelId,
      content: record.content ?? payload?.text,
      messageId: record.messageId ?? hookCtx.messageId,
      deliveredMessageId: record.deliveredMessageId,
      metadata: record.metadata ?? payload?.channelData,
      sessionKey: record.sessionKey ?? hookCtx.sessionKey,
      runId: record.runId ?? hookCtx.runId,
      responseAffect: record.responseAffect,
    },
  };
}

const RESPONSE_AFFECT_DIMENSIONS = [
  "valence", "arousal", "dominance", "joy", "anger", "irritation", "sadness", "anxiety",
  "fear", "surprise", "confusion", "disgust", "embarrassment", "pride", "determination",
  "affection", "warmth", "playfulness", "teasing", "deference", "smileIntensity",
  "browTension", "eyeOpenness", "bodyOpenness",
] as const;

const RESPONSE_AFFECT_MARKER = /(?:\r?\n)*\[\[HENT_AFFECT_V2\|([^\r\n]*)\]\]\s*$/;
const RESPONSE_AFFECT_MARKER_PAYLOAD = /^(\[[0-9, ]+\])\|([0-9]{1,3})$/;

const RESPONSE_AFFECT_PROMPT = [
  "For every final user-facing answer, append exactly one transport metadata line after the answer.",
  "Use this exact format with no code fence: [[HENT_AFFECT_V2|[n1,n2,...,n24]|confidence]].",
  "All 25 values must be integers from 0 to 100.",
  `The 24 values are the emotional performance of your answer in this exact order: ${RESPONSE_AFFECT_DIMENSIONS.join(",")}.`,
  "The transport removes this line before delivery. Never discuss or omit it, including for very short answers.",
].join(" ");

function shouldInjectResponseAffect(ctx: unknown): boolean {
  const context = asRecord(ctx);
  const sessionKey = stringValue(context?.sessionKey);
  return Boolean(sessionKey?.includes(":discord:"));
}

type EmbeddedResponseAffect = {
  readonly schemaVersion: "ResponseAffectV2";
  readonly affectSpaceVersion: "AffectSpaceV2";
  readonly dimensions: Record<(typeof RESPONSE_AFFECT_DIMENSIONS)[number], number>;
  readonly confidence: number;
};

export function extractEmbeddedResponseAffect(text: string): {
  readonly text: string;
  readonly markerPresent: boolean;
  readonly affect?: EmbeddedResponseAffect;
} {
  const marker = text.match(RESPONSE_AFFECT_MARKER);
  if (!marker) return { text, markerPresent: false };
  const visibleText = text.slice(0, marker.index).trimEnd();
  const payload = marker[1]?.match(RESPONSE_AFFECT_MARKER_PAYLOAD);
  if (!payload) return { text: visibleText, markerPresent: true };
  try {
    const values = JSON.parse(payload[1]!) as unknown;
    const confidence = Number(payload[2]);
    if (!Array.isArray(values)
      || values.length !== RESPONSE_AFFECT_DIMENSIONS.length
      || !values.every((value) => Number.isInteger(value) && value >= 0 && value <= 100)
      || !Number.isInteger(confidence)
      || confidence < 0
      || confidence > 100) {
      return { text: visibleText, markerPresent: true };
    }
    return {
      text: visibleText,
      markerPresent: true,
      affect: {
        schemaVersion: "ResponseAffectV2",
        affectSpaceVersion: "AffectSpaceV2",
        dimensions: Object.fromEntries(RESPONSE_AFFECT_DIMENSIONS.map((dimension, index) => [dimension, Number(values[index]) / 100])) as EmbeddedResponseAffect["dimensions"],
        confidence: confidence / 100,
      },
    };
  } catch {
    return { text: visibleText, markerPresent: true };
  }
}

function applyMediaToPayload(payload: Record<string, unknown>, media: OpenClawStage1Media): Record<string, unknown> {
  return {
    ...payload,
    mediaUrl: media.mediaUrl,
    ...(media.mediaUrls ? { mediaUrls: media.mediaUrls } : {}),
    ...(media.sensitiveMedia !== undefined ? { sensitiveMedia: media.sensitiveMedia } : {}),
    ...(media.channelData ? { channelData: { ...(asRecord(payload.channelData) ?? {}), ...media.channelData } } : {}),
  };
}


function channelIdFromEvent(event: unknown, ctx?: unknown): string | undefined {
  const record = asRecord(event) ?? {};
  const metadata = asRecord(record.metadata);
  const context = asRecord(ctx);
  return normalizeDiscordChannelId(
    stringValue(record.channelId)
      ?? stringValue(record.to)
      ?? stringValue(metadata?.to)
      ?? stringValue(context?.conversationId)
      ?? stringValue(context?.parentConversationId)
      ?? stringValue(context?.channelId),
  );
}

export function outboundTargetFromEvent(event: unknown, ctx?: unknown): OpenClawOutboundTarget | null {
  const record = asRecord(event) ?? {};
  const metadata = asRecord(record.metadata);
  const context = asRecord(ctx);
  const channel = stringValue(context?.channelId) ?? stringValue(record.channel);
  const to = stringValue(record.to)
    ?? stringValue(metadata?.to)
    ?? stringValue(context?.conversationId)
    ?? stringValue(context?.parentConversationId);
  if (!channel || !to) return null;
  const accountId = stringValue(context?.accountId) ?? stringValue(record.accountId);
  return { channel, to, ...(accountId ? { accountId } : {}) };
}

function safeSleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addToSuppressSet(set: Set<string>, value: string, maxSize: number): void {
  if (set.size >= maxSize) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

function isConversationDeliveryPlan(value: unknown): value is ConversationDeliveryPlan {
  const record = asRecord(value);
  if (!record) return false;
  if (!isNonEmptyString(record.planId) || !isNonEmptyString(record.scopeId) || !isNonEmptyString(record.channelId)) return false;

  const chunksValue = asArray(record.chunks);
  if (!chunksValue) return false;
  const chunks = chunksValue.map((chunkValue) => {
    const chunk = asRecord(chunkValue);
    const metadata = asRecord(chunk?.metadata);
    if (!chunk || !isNonEmptyString(chunk.chunkId) || !isNonEmptyString(chunk.text) || !isFiniteDelay(chunk.delayMs)) return undefined;

    const planMetadata = metadata?.hentAiConversationChunk === true
      && isNonEmptyString(metadata.planId)
      && Number.isInteger(metadata.chunkIndex)
      && Number.isInteger(metadata.chunkCount)
      && typeof metadata.chunkCount === "number"
      && metadata.chunkCount > 0
      ? {
          hentAiConversationChunk: true as const,
          planId: metadata.planId,
          chunkIndex: metadata.chunkIndex,
          chunkCount: metadata.chunkCount,
        }
      : null;

    if (!planMetadata) return undefined;
    return {
      chunkId: chunk.chunkId,
      text: chunk.text.trim(),
      delayMs: chunk.delayMs,
      metadata: planMetadata,
    } as ConversationDeliveryChunk;
  });

  if (chunks.some((chunk) => chunk === undefined)) return false;
  const validChunks = chunks as readonly ConversationDeliveryChunk[];
  if (validChunks.length === 0) return false;

  const commit = asRecord(record.commit);
  if (!commit) return false;
  const requiredChunkIds = asStringArray(commit.requiredChunkIds);
  if (!requiredChunkIds || requiredChunkIds.length === 0) return false;
  if (!isNonEmptyString(commit.planId) || !isNonEmptyString(commit.cooldownKey) || !isNonEmptyString(commit.signalId)) return false;
  return commit.planId === record.planId && validChunks.every((chunk) => chunk.metadata.planId === record.planId);
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value as unknown[];
  if (values.length === 0) return undefined;
  return values.every(isNonEmptyString) ? values : undefined;
}

function parseMessageSentResponse(value: unknown): MessageSentServiceResponse | null {
  const record = asRecord(value);
  if (!record) return null;
  const deliveryPlan = isConversationDeliveryPlan(record.deliveryPlan) ? record.deliveryPlan : undefined;
  if (deliveryPlan?.dispatch) {
    const dispatch = asRecord(deliveryPlan.dispatch);
    const receipts = asRecord(dispatch?.deliveryMessageIds);
    if (!isNonEmptyString(dispatch?.claimId) || typeof dispatch?.expiresAtMs !== "number" || !Number.isFinite(dispatch.expiresAtMs)
      || !receipts || !Object.entries(receipts).every(([key, value]) => deliveryPlan.commit.requiredChunkIds.includes(key) && isNonEmptyString(value))) return null;
  }
  const nudgeText = isNonEmptyString(record.nudgeText) ? record.nudgeText : undefined;
  return { deliveryPlan, nudgeText, audit: record.audit };
}

async function sendConversationDeliveryPlan(
  sender: OpenClawMessageSender | undefined,
  response: ConversationDeliveryPlan,
  target: OpenClawOutboundTarget,
  scopeId: string,
  channelId: string,
  baseConfig: { baseUrl: URL; token: string; timeoutMs: number },
  suppressMessageIds: Set<string>,
  suppressMaxSize: number,
  logger?: Logger,
): Promise<void> {
  const deliveryMessageIds: Record<string, string> = { ...response.dispatch?.deliveryMessageIds };
  const requiredChunkIds = new Set(response.commit.requiredChunkIds);
  const progress = async (action: "begin" | "receipt" | "release", chunkId?: string, messageId?: string): Promise<boolean> => {
    if (!response.dispatch) return true;
    const result = await callJsonService({ ...baseConfig, endpoint: "/v1/watcher/delivery-progress",
      body: { planId: response.planId, claimId: response.dispatch.claimId, action, chunkId, messageId }, logger });
    return asRecord(result)?.ok === true;
  };
  try {
    for (const chunk of response.chunks) {
      if (deliveryMessageIds[chunk.chunkId]) continue;
      if (!sender?.sendText) return;
      await safeSleep(chunk.delayMs);
      if (!await serviceChannelEligible({ ...baseConfig, channelId, logger })) return;
      if (!await progress("begin", chunk.chunkId)) return;
      const sentMessageId = await sender.sendText(target, chunk.text);
      if (!sentMessageId) return;
      if (requiredChunkIds.has(chunk.chunkId)) {
        deliveryMessageIds[chunk.chunkId] = sentMessageId;
        addToSuppressSet(suppressMessageIds, sentMessageId, suppressMaxSize);
        if (!await progress("receipt", chunk.chunkId, sentMessageId)) return;
      }
    }

    const allChunkIds = response.commit.requiredChunkIds.every((chunkId) => deliveryMessageIds[chunkId]);
    if (!allChunkIds) return;

    const responseJson = await callJsonService({
      baseUrl: baseConfig.baseUrl,
      token: baseConfig.token,
      timeoutMs: baseConfig.timeoutMs,
      endpoint: "/v1/watcher/commit-delivery",
      body: {
        planId: response.commit.planId,
        cooldownKey: response.commit.cooldownKey,
        scopeId,
        signalId: response.commit.signalId,
        deliveryMessageIds,
      },
      logger,
    });
    if (!responseJson) return;
  } finally {
    await progress("release");
  }
}


function watcherScopeId(channelId: string, event: unknown, ctx?: unknown): { scopeId: string; threadId?: string; sessionId?: string } {
  const record = asRecord(event) ?? {};
  const metadata = asRecord(record.metadata);
  const context = asRecord(ctx);
  const threadId = stringValue(record.threadId) ?? stringValue(metadata?.threadId) ?? stringValue(metadata?.thread_id) ?? stringValue(context?.threadId);
  const sessionId = stringValue(record.sessionKey) ?? stringValue(metadata?.sessionId) ?? stringValue(metadata?.session_id) ?? stringValue(context?.sessionKey);
  const parts = [`channel:${channelId}`];
  if (threadId) parts.push(`thread:${threadId}`);
  if (sessionId) parts.push(`session:${sessionId}`);
  return { scopeId: parts.join(":"), threadId, sessionId };
}


async function serviceMediaForPreReply(params: {
  event: unknown;
  ctx: unknown;
  config: { baseUrl: URL; token: string; timeoutMs: number };
  logger?: Logger;
}): Promise<OpenClawStage1Media | null> {
  const record = asRecord(params.event) ?? {};
  const content = stringValue(record.content);
  const channelId = channelIdFromEvent(params.event, params.ctx);
  if (!content || !channelId) return null;
  const result = await callHentAiService({
    baseUrl: params.config.baseUrl,
    token: params.config.token,
    timeoutMs: params.config.timeoutMs,
    endpoint: "/v1/pre-reply/media",
    body: { context: { channelId, content, messageId: record.messageId }, userMessage: content },
    responseMediaPath: "media",
    logger: params.logger,
  });
  return result.media;
}

async function callJsonService(params: {
  baseUrl: URL; token: string; timeoutMs: number; endpoint: string; body: unknown; logger?: Logger;
}): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(endpointUrl(params.baseUrl, params.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${params.token}`, "content-type": "application/json" },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      loggerWarn(params.logger, `hent-ai adapter: ${params.endpoint} returned HTTP ${response.status}`);
      return null;
    }
    return asRecord(await response.json());
  } catch (error) {
    loggerWarn(params.logger, `hent-ai adapter: ${params.endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function serviceChannelEligible(params: {
  baseUrl: URL;
  token: string;
  timeoutMs: number;
  channelId: string;
  logger?: Logger;
}): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  const endpoint = `/v1/channels/${encodeURIComponent(params.channelId)}/mapping`;
  try {
    const response = await fetch(endpointUrl(params.baseUrl, endpoint), {
      method: "GET",
      headers: { authorization: `Bearer ${params.token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      loggerWarn(params.logger, `hent-ai adapter: ${endpoint} returned HTTP ${response.status}; watcher delivery suppressed`);
      return false;
    }
    const mapping = asRecord(asRecord(await response.json())?.mapping);
    const eligible = mapping?.enabled === true;
    if (!eligible) {
      loggerInfo(params.logger, `hent-ai adapter: watcher delivery suppressed for unmapped or disabled channel=${params.channelId}`);
    }
    return eligible;
  } catch (error) {
    loggerWarn(params.logger, `hent-ai adapter: ${endpoint} failed; watcher delivery suppressed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWatcherResponse(params: {
  sender: OpenClawMessageSender | undefined;
  response: MessageSentServiceResponse | null;
  target: OpenClawOutboundTarget | null;
  scopeId: string;
  channelId: string;
  config: { baseUrl: URL; token: string; timeoutMs: number };
  suppressMessageIds: Set<string>;
  suppressMaxSize: number;
  logger?: Logger;
}): Promise<void> {
  const { response } = params;
  if (!response || (!response.deliveryPlan && !response.nudgeText)) return;
  if (!params.sender || !params.target) {
    loggerWarn(params.logger, "hent-ai adapter: watcher delivery suppressed because no host outbound route is available");
    return;
  }
  if (response.deliveryPlan
    && (response.deliveryPlan.channelId !== params.channelId || response.deliveryPlan.scopeId !== params.scopeId)) {
    loggerWarn(params.logger, "hent-ai adapter: watcher delivery suppressed because service plan route does not match the hook route");
    return;
  }
  if (response.deliveryPlan) {
    await sendConversationDeliveryPlan(
      params.sender,
      response.deliveryPlan,
      params.target,
      params.scopeId,
      params.channelId,
      params.config,
      params.suppressMessageIds,
      params.suppressMaxSize,
      params.logger,
    );
    return;
  }

  const nudgeText = response.nudgeText;
  if (!nudgeText) return;
  if (!await serviceChannelEligible({ ...params.config, channelId: params.channelId, logger: params.logger })) return;
  const deliveryMessageId = await params.sender.sendText?.(params.target, nudgeText);
  if (deliveryMessageId) addToSuppressSet(params.suppressMessageIds, deliveryMessageId, params.suppressMaxSize);
  const audit = asRecord(response.audit);
  const cooldownKey = stringValue(audit?.cooldownKey);
  const signalId = stringValue(audit?.internalSignalId);
  if (!deliveryMessageId || !cooldownKey || !signalId) return;
  await callJsonService({
    baseUrl: params.config.baseUrl,
    token: params.config.token,
    timeoutMs: params.config.timeoutMs,
    endpoint: "/v1/watcher/commit-delivery",
    body: { cooldownKey, scopeId: params.scopeId, signalId, deliveryMessageId },
    logger: params.logger,
  });
}

async function handleReplyPayloadSending(params: {
  event: unknown;
  ctx: unknown;
  config: { baseUrl: URL; token: string; timeoutMs: number };
  logger?: Logger;
}): Promise<{ payload?: Record<string, unknown> } | void> {
  const event = asRecord(params.event) ?? {};
  const payload = asRecord(event.payload);
  if (!payload) return undefined;
  const kind = stringValue(event.kind);
  const originalText = stringValue(payload.text);
  const embedded = originalText ? extractEmbeddedResponseAffect(originalText) : null;
  const text = embedded?.text ?? originalText;
  if (!text || kind !== "final") return undefined;
  const cleanPayload = embedded?.markerPresent ? { ...payload, text } : payload;

  const serviceResult = await callHentAiService({
    baseUrl: params.config.baseUrl,
    token: params.config.token,
    timeoutMs: params.config.timeoutMs,
    endpoint: "/v1/final-response/verdict",
    body: messageSentBody({
      payload: cleanPayload,
      content: text,
      sessionKey: event.sessionKey,
      runId: event.runId,
      responseAffect: embedded?.affect,
    }, params.ctx),
    responseMediaPath: "verdict.media",
    logger: params.logger,
  });

  if (serviceResult.media) return { payload: applyMediaToPayload(cleanPayload, serviceResult.media) };
  return embedded?.markerPresent ? { payload: cleanPayload } : undefined;
}

function supportsReplyPayloadSending(api: PluginApi): boolean {
  // Current OpenClaw hosts support reply_payload_sending but do not always
  // expose the optional supportsHook probe to plugins. Treat an absent probe as
  // supported. There is intentionally no legacy hook fallback: unsupported hosts
  // should skip registration instead of registering ignored/unknown hooks.
  if (!api.supportsHook) return true;
  return api.supportsHook("reply_payload_sending") === true;
}

export default definePluginEntry({
  id: "hent-ai-service-adapter",
  name: "Hent-ai Service Adapter",
  description: "Delegates OpenClaw media lifecycle hooks to the Hent-ai service.",

  register(api: PluginApi) {
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

    if (!supportsReplyPayloadSending(api)) {
      loggerWarn(api.logger, "hent-ai adapter disabled: reply_payload_sending hook unsupported");
      return;
    }

    const sender = createOpenClawMessageSender(api);
    const serviceFeatureConfig = resolveServiceConfig(api);
    const preReplyMediaEnabled = featureEnabled(serviceFeatureConfig?.preReplyMedia, false);
    const selfLoopMessageIds = new Set<string>();
    const SELF_LOOP_MAX_SIZE = 100;
    const serviceConversation = serviceFeatureConfig?.conversation;
    const watcherEnabled = serviceConversation?.enabled === false
      ? false
      : serviceConversation?.enabled === true || featureEnabled(serviceFeatureConfig?.watcher, false);
    const conversation = serviceConversation ? {
      ...(typeof serviceConversation.enabled === "boolean" ? { enabled: serviceConversation.enabled } : {}),
      ...(typeof serviceConversation.watcherCompatibility === "boolean" ? { watcherCompatibility: serviceConversation.watcherCompatibility } : {}),
    } : undefined;

    api.on("before_prompt_build", (_event: unknown, ctx: unknown) => shouldInjectResponseAffect(ctx)
      ? { appendSystemContext: RESPONSE_AFFECT_PROMPT }
      : undefined, {
      name: "hent-ai-response-affect-v2",
    });

    api.on("message_sending", (event: unknown) => {
      const record = asRecord(event);
      const content = stringValue(record?.content);
      if (!content) return undefined;
      const embedded = extractEmbeddedResponseAffect(content);
      return embedded.markerPresent ? { content: embedded.text } : undefined;
    }, { name: "hent-ai-response-affect-v2-sanitizer" });

    api.on("message_received", async (event: unknown, ctx: unknown) => {
      const channelId = channelIdFromEvent(event, ctx);
      const outboundTarget = outboundTargetFromEvent(event, ctx);
      const record = asRecord(event) ?? {};
      const content = stringValue(record.content);
      if (!channelId || !content) return;
      const scope = watcherScopeId(channelId, event, ctx);
      if (watcherEnabled) {
        const recordResult = await callJsonService({
          baseUrl: config.baseUrl,
          token: config.token,
          timeoutMs: config.timeoutMs,
          endpoint: "/v1/watcher/record-user",
          body: { scopeId: scope.scopeId, text: content, id: stringValue(record.messageId), channelId, ...(conversation ? { conversation } : {}) },
          logger: api.logger,
        });
        // Evaluate immediately on user message intake
        const messageId = stringValue(record.messageId) ?? `intake-${Date.now()}`;
        const evalResult = parseMessageSentResponse(await callJsonService({
          baseUrl: config.baseUrl,
          token: config.token,
          timeoutMs: config.timeoutMs,
          endpoint: "/v1/watcher/evaluate",
          body: {
            trigger: "user",
            scopeId: scope.scopeId,
            channelId,
            text: content,
            messageId,
            sourceThreadId: scope.threadId,
            sessionId: scope.sessionId,
            ...(conversation ? { conversation } : {}),
          },
          logger: api.logger,
        })) ?? null;
        await deliverWatcherResponse({
          sender,
          response: evalResult,
          target: outboundTarget,
          scopeId: scope.scopeId,
          channelId,
          config,
          suppressMessageIds: selfLoopMessageIds,
          suppressMaxSize: SELF_LOOP_MAX_SIZE,
          logger: api.logger,
        });
      }
      if (preReplyMediaEnabled) {
        const media = await serviceMediaForPreReply({ event, ctx, config, logger: api.logger });
        if (media?.mediaUrl && outboundTarget) {
          await sender?.sendMedia?.(outboundTarget, media.mediaUrl, media.caption ?? "");
        }
      }
    }, { name: "hent-ai-service-message-received" });

    api.on("message_sent", async (event: unknown, ctx: unknown) => {
      if (!watcherEnabled) return;
      const record = asRecord(event) ?? {};
      if (record.success === false) return;
      const content = stringValue(record.content);
      const messageId = stringValue(record.messageId);
      const channelId = normalizeDiscordChannelId(stringValue(record.to)) ?? channelIdFromEvent(event, ctx);
      if (!channelId || !content || !messageId) return;
      const marker = asRecord(record.metadata)?.hentAiWatcherNudge;
      const chunkMarker = asRecord(record.metadata)?.hentAiConversationChunk;
      if (marker === true) return;
      if (messageId && selfLoopMessageIds.has(messageId)) {
        selfLoopMessageIds.delete(messageId);
        return;
      }
      if (chunkMarker === true) return;
      const scope = watcherScopeId(channelId, event, ctx);
      const outboundTarget = outboundTargetFromEvent(event, ctx);
      const sourceThreadId = stringValue(record.sourceThreadId) ?? stringValue(asRecord(record.metadata)?.sourceThreadId) ?? scope.threadId;
      const targetThreadId = stringValue(record.targetThreadId) ?? stringValue(asRecord(record.metadata)?.targetThreadId) ?? scope.threadId;
      const result = parseMessageSentResponse(await callJsonService({
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs: config.timeoutMs,
        endpoint: "/v1/watcher/evaluate",
        body: {
          scopeId: scope.scopeId,
          channelId,
          text: content,
          messageId,
          sourceThreadId,
          targetThreadId,
          sessionId: scope.sessionId,
          ...(conversation ? { conversation } : {}),
        },
        logger: api.logger,
      })) ?? null;
      await deliverWatcherResponse({
        sender,
        response: result,
        target: outboundTarget,
        scopeId: scope.scopeId,
        channelId,
        config,
        suppressMessageIds: selfLoopMessageIds,
        suppressMaxSize: SELF_LOOP_MAX_SIZE,
        logger: api.logger,
      });
    }, { name: "hent-ai-service-watcher" });

    api.on("reply_payload_sending", async (event: unknown, ctx: unknown) => handleReplyPayloadSending({
      event,
      ctx,
      config,
      logger: api.logger,
    }), { name: "hent-ai-final-reply-payload-media" });
  },
});
