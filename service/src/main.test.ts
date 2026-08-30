import { describe, expect, it } from "vitest";
import * as service from "./index.js";
import { importAssets } from "./importer.js";
import { tempDir, writeFixtureAssets } from "./service-test-helpers.js";

describe("API-only entrypoint", () => {
  it("starts API without participant worker", async () => {
    const candidate = Reflect.get(service, "createApiService");
    expect(candidate, "starts API without participant worker through the service namespace").toBeTypeOf("function");
    let opened = 0;
    let closed = 0;
    let listened = 0;
    let configuredAssetRoot: string | undefined;
    const api = (candidate as typeof service.createApiService)({
      config: { dbPath: ":memory:", token: "test-token", port: 8787, hostname: "127.0.0.1", assetRoot: "/tmp/hent-assets" },
      verifier: { verify: async () => null },
      createDatabase: () => ({ close: () => { closed += 1; } }) as unknown as service.ServiceDatabase,
      createServer: (options) => {
        configuredAssetRoot = options.assetRoot;
        return {} as never;
      },
      listenServer: async () => {
        listened += 1;
        return { url: "http://127.0.0.1:8787", close: async () => { opened += 1; } };
      },
    });
    const binding = await api.start();
    expect(listened).toBe(1);
    expect(configuredAssetRoot).toBe("/tmp/hent-assets");
    expect(opened).toBe(0);
    await binding.stop();
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it("requires explicit API configuration", () => {
    expect(() => service.loadApiServiceConfig({})).toThrow("HENT_AI_SERVICE_DB_PATH");
  });

  it("configures a repository asset root by default and accepts an explicit override", () => {
    const required = { HENT_AI_SERVICE_DB_PATH: ":memory:", HENT_AI_SERVICE_TOKEN: "token" };
    expect(service.loadApiServiceConfig(required).assetRoot).toMatch(/[/\\]assets$/);
    expect(service.loadApiServiceConfig({ ...required, HENT_AI_ASSET_ROOT: " /srv/hent-assets " }).assetRoot).toBe("/srv/hent-assets");
  });

  it("serves DB-registered relative media through the API-only composition", async () => {
    const root = tempDir();
    writeFixtureAssets(root);
    const dbPath = `${root}/service.sqlite`;
    const seeded = new service.ServiceDatabase(dbPath);
    importAssets({ db: seeded, assetRoot: root });
    seeded.close();

    const api = service.createApiService({
      config: { dbPath, token: "test-token", port: 0, hostname: "127.0.0.1", assetRoot: root },
      verifier: { verify: async () => null },
    });
    const binding = await api.start();
    try {
      const response = await fetch(`${binding.url}/static/sets/gothic-v1/neutral.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("fake png");
    } finally {
      await binding.stop();
    }
  });
});
