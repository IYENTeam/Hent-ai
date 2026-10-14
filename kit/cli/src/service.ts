import type { HentConfig } from "./config.ts";

export type Result<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

export type ServiceMedia = {
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sensitiveMedia: boolean;
};

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
/** One deadline per send; the caller creates it and hands the same signal to verdict() and fetchMedia(). */
export const sendDeadline = (): AbortSignal => AbortSignal.timeout(2000);

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

export const verdict = async (
  config: HentConfig,
  channelId: string,
  text: string,
  affect: unknown,
  signal: AbortSignal,
): Promise<Result<{ media: ServiceMedia | null }>> => {
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
    const v = (parsed as { verdict?: { media?: unknown } | null } | null)?.verdict;
    return { ok: true, media: parseMedia(v?.media) };
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
