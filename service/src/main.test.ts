import { describe, expect, it } from "vitest";
import * as service from "./index.js";

describe("API-only entrypoint", () => {
  it("starts API without participant worker", async () => {
    const candidate = Reflect.get(service, "createApiService");
    expect(candidate, "starts API without participant worker through the service namespace").toBeTypeOf("function");
    let opened = 0;
    let closed = 0;
    let listened = 0;
    const api = (candidate as typeof service.createApiService)({
      config: { dbPath: ":memory:", token: "test-token", port: 8787, hostname: "127.0.0.1" },
      verifier: { verify: async () => null },
      createDatabase: () => ({ close: () => { closed += 1; } }) as unknown as service.ServiceDatabase,
      createServer: () => ({}) as never,
      listenServer: async () => {
        listened += 1;
        return { url: "http://127.0.0.1:8787", close: async () => { opened += 1; } };
      },
    });
    const binding = await api.start();
    expect(listened).toBe(1);
    expect(opened).toBe(0);
    await binding.stop();
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it("requires explicit API configuration", () => {
    expect(() => service.loadApiServiceConfig({})).toThrow("HENT_AI_SERVICE_DB_PATH");
  });
});
