// Ported from Dori (sisyphuslabs/omo-dori-mode-experimental @ 40034ad,
// skills/dori-mode/scripts/src/messenger/http.ts), MIT License, Copyright (c) 2026 YeonGyu Kim.
// Changes: guardText's "$(" refusal is not ported (the kit is argv-only and replies may
// legitimately contain shell snippets); Discord surface reshaped for the Hent-ai bridge.

import type { Clock } from "../run.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
};
export type HttpResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MessengerError";
  }
}

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

/** Retries 429 and 5xx only; any other status (including 4xx such as 403) returns at once. */
export const withBackoff = async (http: Http, clock: Clock, req: HttpRequest, policy: RetryPolicy = DEFAULT_RETRY, retryAfterFromBody?: (body: string) => number | undefined): Promise<HttpResponse> => {
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    last = await http(req);
    if (last.status !== 429 && last.status < 500) return last;
    const header = Number(last.headers["retry-after"]);
    const fromBody = retryAfterFromBody?.(last.body);
    const waitS = Number.isFinite(header) && header > 0 ? header : fromBody;
    const waitMs = waitS !== undefined ? waitS * 1000 : Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
    if (attempt < policy.attempts - 1) await clock.sleep(Math.min(policy.maxMs, waitMs));
  }
  return last as HttpResponse;
};
