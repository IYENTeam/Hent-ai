// Fake Http/Clock in the style of Dori's scripts/test/fakes.ts (MIT, sisyphuslabs/omo-dori-mode-experimental @ 40034ad).
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import type { Clock } from "../src/run.ts";

export const fakeClock = (start: number): Clock & { at: number; waited: number[] } => {
  const c = {
    at: start,
    waited: [] as number[],
    now: () => c.at,
    sleep: async (ms: number) => {
      c.waited.push(ms);
      c.at += ms;
    },
  };
  return c;
};

export type Script = (req: HttpRequest, n: number) => HttpResponse;

export const fakeHttp = (script: Script): { http: Http; seen: HttpRequest[] } => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};

export const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: JSON.stringify(body) });
