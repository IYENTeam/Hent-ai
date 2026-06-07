import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { normalizeDiscordChannelId } from "../index.js";

type Handler = (event: unknown) => Promise<unknown>;

function setup() {
  const events = new Map<string, Handler>();
  const api = {
    pluginConfig: {
      channels: { defaultEnabled: false, overrides: { "blocked": false } },
      hentAiService: { url: "https://hent.test", token: "secret" },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
    on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
  };
  plugin.register(api as any);
  return { events, api };
}

describe("channel policy service delegation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps channel id normalization only for OpenClaw context formatting", () => {
    expect(normalizeDiscordChannelId("channel:123456789")).toBe("123456789");
    expect(normalizeDiscordChannelId("123456789")).toBe("123456789");
  });

  it("does not apply local channel toggles before calling pre-reply service", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ media: null }) }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    await events.get("reply_payload_sending")?.({ kind: "block", payload: { text: "thinking" } }, { channelId: "blocked", replyToBody: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context.channelId).toBe("blocked");
  });

  it("does not apply local channel toggles before calling final-response service", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ verdict: { media: null } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    await events.get("reply_payload_sending")?.({ kind: "final", payload: { text: "done", to: "channel:blocked" } }, { messageId: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context.channelId).toBe("blocked");
  });
});
