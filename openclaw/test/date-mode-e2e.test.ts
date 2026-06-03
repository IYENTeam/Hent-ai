import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

function setup() {
  const events = new Map<string, Handler>();
  const api = {
    pluginConfig: {
      dateMode: { enabled: true, channels: ["date-channel"] },
      hentAiService: { url: "https://hent.test", token: "secret" },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
  };
  plugin.register(api as any);
  return { events, api };
}

describe("date-mode media adapter behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not locally suppress date-mode reply media; channel policy is delegated to service", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ verdict: { media: null } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    await events.get("reply_payload_sending")?.({
      channelId: "date-channel",
      payload: { text: "date-mode user message" },
      kind: "final",
      metadata: { mode: "date" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context).toMatchObject({
      channelId: "date-channel",
      finalText: "date-mode user message",
    });
  });

  it("does not classify or replace focused media locally for date-mode final responses", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ verdict: { media: { url: "https://cdn.test/service-choice.png", caption: "service-owned" } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    const result = await events.get("reply_payload_sending")?.({
      to: "channel:date-channel",
      payload: { text: "focused text that used to be rewritten" },
      kind: "final",
      metadata: { mode: "date" },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://hent.test/v1/final-response/verdict", expect.objectContaining({ method: "POST" }));
    expect(result).toMatchObject({ payload: { text: "focused text that used to be rewritten", mediaUrl: "https://cdn.test/service-choice.png" } });
  });

  it("does not register legacy media lifecycle or message_sent patching hooks", () => {
    const { api } = setup();
    expect(api.on).not.toHaveBeenCalledWith("message_sent", expect.any(Function), expect.anything());
    expect(api.on).not.toHaveBeenCalledWith("pre_reply_media", expect.any(Function), expect.anything());
    expect(api.on).not.toHaveBeenCalledWith("message_sent_media", expect.any(Function), expect.anything());
  });
});
