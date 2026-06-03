import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

function setup() {
  const events = new Map<string, Handler>();
  const api = {
    pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret" } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
  };
  plugin.register(api as any);
  return { events, api };
}

describe("reply payload media service delegation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates final response media selection to the service for each reply_payload_sending event", async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ verdict: { media: { url: `https://cdn.test/${JSON.parse(String(options.body)).context.runId}.png` } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();
    const handler = events.get("reply_payload_sending");

    await expect(handler?.({ channelId: "111", payload: { text: "first" }, kind: "final", runId: "first" })).resolves.toMatchObject({
      payload: { mediaUrl: "https://cdn.test/first.png" },
    });
    await expect(handler?.({ channelId: "111", payload: { text: "second" }, kind: "final", runId: "second" })).resolves.toMatchObject({
      payload: { mediaUrl: "https://cdn.test/second.png" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://hent.test/v1/final-response/verdict",
      "https://hent.test/v1/final-response/verdict",
    ]);
  });

  it("does not register legacy message_received focused-image sender", () => {
    const { api } = setup();
    expect(api.on).not.toHaveBeenCalledWith("message_received", expect.any(Function), expect.anything());
    expect(api.on).not.toHaveBeenCalledWith("pre_reply_media", expect.any(Function), expect.anything());
  });
});
