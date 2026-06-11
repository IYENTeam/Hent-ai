import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

type Handler = (event: unknown) => Promise<unknown>;

function setup() {
  const events = new Map<string, Handler>();
  const api = {
    pluginConfig: { hentAiService: { url: "https://hent.test", token: "secret" } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
    on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
  };
  plugin.register(api as any);
  return { events, api };
}

describe("final-only media service delegation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not delegate thinking block media; final-only attachment prevents duplicates", async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ media: { url: `https://cdn.test/${JSON.parse(String(options.body)).context.runId}.png` } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();
    const handler = events.get("reply_payload_sending");

    await expect(handler?.({ kind: "block", payload: { text: "thinking" }, runId: "first" }, { channelId: "111", replyToBody: "first" })).resolves.toBeUndefined();
    await expect(handler?.({ kind: "block", payload: { text: "thinking" }, runId: "second" }, { channelId: "111", replyToBody: "second" })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not register legacy message_received focused-image sender", () => {
    const { api } = setup();
    expect(api.on).not.toHaveBeenCalledWith("message_received", expect.any(Function), expect.anything());
  });
});
