import type { HentConfig } from "./config.ts";

export type Result<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

export type ServiceMedia = {
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sensitiveMedia: boolean;
};

/** How the service picked the image: fit distance, the generate threshold, and the closest candidates. */
export type ServiceRoutingNeighbour = { readonly url: string; readonly filename: string; readonly distance: number };
export type ServiceRouting = {
  readonly mode: string;
  readonly distance: number | null;
  readonly threshold: number | null;
  readonly generate: boolean;
  readonly nearest: readonly ServiceRoutingNeighbour[];
};

/** Body of POST /v1/assets; `visualAffect` is validated by the service, not here. */
export type AssetRegistration = {
  readonly channelId: string;
  readonly emotion: string;
  readonly contentType: string;
  readonly dataBase64: string;
  readonly visualAffect: unknown;
  readonly prompt?: string;
};

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
/** One deadline per send; the caller creates it and hands the same signal to verdict() and fetchMedia(). */
export const sendDeadline = (): AbortSignal => AbortSignal.timeout(2000);
/** Registering an image uploads it and writes the asset row; an explicit command, not a reply. */
export const assetDeadline = (): AbortSignal => AbortSignal.timeout(15_000);

const failure = (error: unknown, signal: AbortSignal): { ok: false; reason: string } => ({
  ok: false,
  reason: signal.aborted ? "timeout" : error instanceof Error ? error.message : String(error),
});

const parseMedia = (value: unknown): ServiceMedia | null => {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.url !== "string" || typeof m.filename !== "string" || typeof m.contentType !== "string") return null;
  return { url: m.url, filename: m.filename, contentType: m.contentType, sensitiveMedia: m.sensitiveMedia === true };
};

const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A service without the routing fields (or with malformed ones) reads as "no fit signal": never generate. */
const parseRouting = (value: unknown): ServiceRouting | null => {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.mode !== "string" || typeof r.generate !== "boolean") return null;
  const nearest: ServiceRoutingNeighbour[] = [];
  for (const entry of Array.isArray(r.nearest) ? r.nearest : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const n = entry as Record<string, unknown>;
    const distance = finiteOrNull(n.distance);
    if (typeof n.url !== "string" || typeof n.filename !== "string" || distance === null) continue;
    nearest.push({ url: n.url, filename: n.filename, distance });
  }
  return { mode: r.mode, distance: finiteOrNull(r.distance), threshold: finiteOrNull(r.threshold), generate: r.generate, nearest };
};

const serviceMessage = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : "";
    if (message) return message.slice(0, 200);
  } catch {
    // not JSON; fall through to the raw body
  }
  return body.trim().slice(0, 200);
};

export const verdict = async (
  config: HentConfig,
  channelId: string,
  text: string,
  affect: unknown,
  signal: AbortSignal,
): Promise<Result<{ media: ServiceMedia | null; routing: ServiceRouting | null }>> => {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  if (!config.url) return { ok: false, reason: "no_url" };
  if (config.tokenProblem) return { ok: false, reason: config.tokenProblem };
  try {
    const res = await fetch(`${config.url}/v1/final-response/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify({ context: { channelId, content: text, responseAffect: affect } }),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, reason: `http_${res.status}` };
    }
    const parsed: unknown = await res.json();
    const v = (parsed as { verdict?: { media?: unknown; routing?: unknown } | null } | null)?.verdict;
    return { ok: true, media: parseMedia(v?.media), routing: parseRouting(v?.routing) };
  } catch (error) {
    return failure(error, signal);
  }
};

/** Registers an image the brain produced into the channel's asset set (POST /v1/assets). */
export const registerAsset = async (
  config: HentConfig,
  asset: AssetRegistration,
  signal: AbortSignal,
): Promise<Result<{ id: string; url: string | null }>> => {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  if (!config.url) return { ok: false, reason: "no_url" };
  if (config.tokenProblem) return { ok: false, reason: config.tokenProblem };
  try {
    const res = await fetch(`${config.url}/v1/assets`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify(asset),
      signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `http_${res.status} ${serviceMessage(text)}`.trim() };
    const parsed = JSON.parse(text) as { asset?: { id?: unknown }; media?: { url?: unknown } };
    const id = parsed.asset?.id;
    if (typeof id !== "string" || !id) return { ok: false, reason: "bad_response" };
    return { ok: true, id, url: typeof parsed.media?.url === "string" ? parsed.media.url : null };
  } catch (error) {
    return failure(error, signal);
  }
};

export const fetchMedia = async (
  config: HentConfig,
  url: string,
  signal: AbortSignal,
): Promise<Result<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }>> => {
  if (!config.url) return { ok: false, reason: "no_url" };
  try {
    if (new URL(url, config.url).origin !== new URL(config.url).origin) return { ok: false, reason: "cross_origin" };
    const res = await fetch(new URL(url, config.url), {
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
      redirect: "error",
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, reason: `http_${res.status}` };
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      await res.body?.cancel();
      return { ok: false, reason: "bad_content_type" };
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      await res.body?.cancel();
      return { ok: false, reason: "too_large" };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
    if (total === 0) return { ok: false, reason: "empty" };
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { ok: true, bytes, contentType };
  } catch (error) {
    return failure(error, signal);
  }
};
