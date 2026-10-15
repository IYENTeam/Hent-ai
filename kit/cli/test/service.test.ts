import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HentConfig } from "../src/config.ts";
import { fetchMedia, MAX_MEDIA_BYTES, registerAsset, verdict } from "../src/service.ts";

const png = new Uint8Array([137, 80, 78, 71]);
let seenAuth = "";
let seenBody = "";
let server: ReturnType<typeof Bun.serve>;
let cfg: HentConfig;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/final-response/verdict") {
        seenAuth = req.headers.get("authorization") ?? "";
        seenBody = await req.text();
        const mode = req.headers.get("x-mode");
        if (mode === "500") return new Response("boom", { status: 500 });
        if (mode === "401") return new Response("no", { status: 401 });
        if (mode === "hang") return new Promise<Response>(() => {});
        return Response.json({ verdict: { emotion: "happy", media: { url: "/m/a.png", filename: "a.png", contentType: "image/png", sensitiveMedia: false } } });
      }
      if (path === "/m/a.png") return new Response(png, { headers: { "content-type": "image/png" } });
      if (path === "/m/text") return new Response("hi", { headers: { "content-type": "text/html" } });
      if (path === "/m/big") return new Response(new Uint8Array(MAX_MEDIA_BYTES + 1), { headers: { "content-type": "image/png" } });
      return new Response("nf", { status: 404 });
    },
  });
  cfg = { enabled: true, url: `http://127.0.0.1:${server.port}`, token: "tok", tokenProblem: undefined };
});
afterAll(() => server.stop(true));

const signal = () => AbortSignal.timeout(2000);

describe("verdict", () => {
  test("posts context with bearer and parses media; a verdict without routing carries no fit signal", async () => {
    const r = await verdict(cfg, "c1", "hello", { v: 2 }, signal());
    expect(r).toEqual({ ok: true, media: { url: "/m/a.png", filename: "a.png", contentType: "image/png", sensitiveMedia: false }, routing: null });
    expect(seenAuth).toBe("Bearer tok");
    expect(JSON.parse(seenBody)).toEqual({ context: { channelId: "c1", content: "hello", responseAffect: { v: 2 } } });
  });

  const withVerdict = async (body: unknown, run: (config: HentConfig) => Promise<unknown>): Promise<unknown> => {
    const s = Bun.serve({ port: 0, fetch: () => Response.json(body) });
    try {
      return await run({ ...cfg, url: `http://127.0.0.1:${s.port}` });
    } finally {
      s.stop(true);
    }
  };

  test("routing is read from the verdict", async () => {
    const routing = {
      mode: "affect-v2",
      distance: 0.42,
      threshold: 0.3,
      generate: true,
      nearest: [
        { url: "/m/a.png", filename: "a.png", distance: 0.42 },
        { url: "/m/b.png", filename: "b.png", distance: 0.55 },
      ],
    };
    const r = await withVerdict({ verdict: { media: { url: "/m/a.png", filename: "a.png", contentType: "image/png" }, routing } }, (c) =>
      verdict(c, "c1", "t", { v: 2 }, signal()),
    );
    expect(r).toMatchObject({ ok: true, routing });
  });

  test("legacy-fallback routing keeps generate false and an empty nearest list", async () => {
    const routing = { mode: "legacy-fallback", distance: null, threshold: null, generate: false, nearest: [] };
    const r = await withVerdict({ verdict: { media: { url: "/m/a.png", filename: "a.png", contentType: "image/png" }, routing } }, (c) =>
      verdict(c, "c1", "t", { v: 2 }, signal()),
    );
    expect(r).toMatchObject({ ok: true, routing });
  });

  test("malformed routing is dropped, and a malformed neighbour does not poison the rest", async () => {
    const broken = await withVerdict({ verdict: { media: { url: "/m/a.png", filename: "a.png", contentType: "image/png" }, routing: { mode: 7, generate: "yes" } } }, (c) =>
      verdict(c, "c1", "t", { v: 2 }, signal()),
    );
    expect(broken).toMatchObject({ ok: true, routing: null });
    const partial = await withVerdict(
      {
        verdict: {
          media: { url: "/m/a.png", filename: "a.png", contentType: "image/png" },
          routing: { mode: "affect-v2", distance: "far", threshold: 0.3, generate: false, nearest: [{ url: "/m/a.png", filename: "a.png" }, null, { url: "/m/b.png", filename: "b.png", distance: 0.1 }] },
        },
      },
      (c) => verdict(c, "c1", "t", { v: 2 }, signal()),
    );
    expect(partial).toMatchObject({
      ok: true,
      routing: { mode: "affect-v2", distance: null, threshold: 0.3, generate: false, nearest: [{ url: "/m/b.png", filename: "b.png", distance: 0.1 }] },
    });
  });

  test("timeout -> reason timeout", async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const r = await verdict({ ...cfg, url: `http://127.0.0.1:${hang.port}` }, "c", "t", null, AbortSignal.timeout(100));
      expect(r).toEqual({ ok: false, reason: "timeout" });
    } finally {
      hang.stop(true);
    }
  });

  for (const status of [500, 401]) {
    test(`http ${status} -> ok:false`, async () => {
      const s = Bun.serve({ port: 0, fetch: () => new Response("x", { status }) });
      try {
        const r = await verdict({ ...cfg, url: `http://127.0.0.1:${s.port}` }, "c", "t", null, signal());
        expect(r).toEqual({ ok: false, reason: `http_${status}` });
      } finally {
        s.stop(true);
      }
    });
  }

  test("disabled config short-circuits", async () => {
    expect(await verdict({ ...cfg, enabled: false }, "c", "t", null, signal())).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("fetchMedia", () => {
  test("returns bytes for same-origin image", async () => {
    const r = await fetchMedia(cfg, "/m/a.png", signal());
    expect(r).toEqual({ ok: true, bytes: png, contentType: "image/png" });
  });
  test("absolute same-origin url accepted", async () => {
    expect((await fetchMedia(cfg, `${cfg.url}/m/a.png`, signal())).ok).toBe(true);
  });
  test("wrong content type", async () => {
    expect(await fetchMedia(cfg, "/m/text", signal())).toEqual({ ok: false, reason: "bad_content_type" });
  });
  test("oversize body", async () => {
    expect(await fetchMedia(cfg, "/m/big", signal())).toEqual({ ok: false, reason: "too_large" });
  });
  test("cross-origin rejected", async () => {
    expect(await fetchMedia(cfg, "http://127.0.0.1:1/m/a.png", signal())).toEqual({ ok: false, reason: "cross_origin" });
  });
  test("404 -> ok:false", async () => {
    expect(await fetchMedia(cfg, "/nope", signal())).toEqual({ ok: false, reason: "http_404" });
  });
});

describe("registerAsset", () => {
  const asset = { channelId: "c1", emotion: "happy", contentType: "image/png", dataBase64: "iVBOR", visualAffect: { schemaVersion: "VisualAffectV2" } };

  test("posts the image with bearer and returns the new asset id", async () => {
    const seen: { auth: string; body: unknown }[] = [];
    const s = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ auth: req.headers.get("authorization") ?? "", body: await req.json() });
        return Response.json({ asset: { id: "native_abc123def456", assetSetId: "set", emotion: "happy", filename: "abc123def456.png" }, media: { url: "/static/native/x.png" } }, { status: 201 });
      },
    });
    try {
      const r = await registerAsset({ ...cfg, url: `http://127.0.0.1:${s.port}` }, asset, signal());
      expect(r).toEqual({ ok: true, id: "native_abc123def456", url: "/static/native/x.png" });
      expect(seen).toEqual([{ auth: "Bearer tok", body: asset }]);
    } finally {
      s.stop(true);
    }
  });

  test("a service rejection carries the status and the service message", async () => {
    const s = Bun.serve({ port: 0, fetch: () => Response.json({ error: "native_asset_error", message: "Invalid visualAffect" }, { status: 400 }) });
    try {
      expect(await registerAsset({ ...cfg, url: `http://127.0.0.1:${s.port}` }, asset, signal())).toEqual({ ok: false, reason: "http_400 Invalid visualAffect" });
    } finally {
      s.stop(true);
    }
  });

  test("an answer without an asset id is not reported as success", async () => {
    const s = Bun.serve({ port: 0, fetch: () => Response.json({ asset: {} }, { status: 201 }) });
    try {
      expect(await registerAsset({ ...cfg, url: `http://127.0.0.1:${s.port}` }, asset, signal())).toEqual({ ok: false, reason: "bad_response" });
    } finally {
      s.stop(true);
    }
  });

  test("no service url and a disabled kit never post", async () => {
    expect(await registerAsset({ ...cfg, url: undefined }, asset, signal())).toEqual({ ok: false, reason: "no_url" });
    expect(await registerAsset({ ...cfg, enabled: false }, asset, signal())).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("loadConfig", () => {
  const home = () => mkdtempSync(join(tmpdir(), "hent-"));
  test("HENT_ENABLED=0 is reported, default is enabled", () => {
    expect(loadConfig({ HENT_HOME: home(), HENT_ENABLED: "0" }).enabled).toBe(false);
    expect(loadConfig({ HENT_HOME: home() }).enabled).toBe(true);
  });
  test("serviceUrl from config.json, HENT_URL overrides", () => {
    const h = home();
    writeFileSync(join(h, "config.json"), JSON.stringify({ serviceUrl: "http://a:1/" }));
    expect(loadConfig({ HENT_HOME: h }).url).toBe("http://a:1");
    expect(loadConfig({ HENT_HOME: h, HENT_URL: "http://b:2" }).url).toBe("http://b:2");
  });
  test("token 0600 accepted, 0644 refused, env overrides", () => {
    const h = home();
    const p = join(h, "service.token");
    writeFileSync(p, "secret\n");
    chmodSync(p, 0o600);
    expect(loadConfig({ HENT_HOME: h }).token).toBe("secret");
    chmodSync(p, 0o644);
    const bad = loadConfig({ HENT_HOME: h });
    expect(bad.token).toBeUndefined();
    expect(bad.tokenProblem).toContain("0600");
    expect(loadConfig({ HENT_HOME: h, HENT_SERVICE_TOKEN: "env" }).token).toBe("env");
  });
});
