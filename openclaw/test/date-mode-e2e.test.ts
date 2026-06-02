import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

type Handler = (event: unknown) => Promise<unknown>;

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

  it("does not locally suppress date-mode pre-reply media; channel policy is delegated to service", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ media: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    await events.get("pre_reply_media")?.({
      channelId: "date-channel",
      userMessage: "date-mode user message",
      preReplyText: "text continues",
      metadata: { mode: "date" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context).toMatchObject({
      channelId: "date-channel",
      userMessage: "date-mode user message",
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

    const result = await events.get("message_sent_media")?.({
      to: "channel:date-channel",
      content: "focused text that used to be rewritten",
      messageId: "msg-1",
      metadata: { mode: "date" },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://hent.test/v1/final-response/verdict", expect.objectContaining({ method: "POST" }));
    expect(result).toMatchObject({ media: { mediaUrl: "https://cdn.test/service-choice.png", caption: "service-owned" } });
  });

  it("does not register legacy message_sent patching hook", () => {
    const { api } = setup();
    expect(api.on).not.toHaveBeenCalledWith("message_sent", expect.any(Function), expect.anything());
  });
});
