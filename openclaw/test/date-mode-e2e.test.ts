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
    supportsHook: vi.fn((name: string) => name === "reply_payload_sending"),
    on: vi.fn((name: string, handler: Handler) => events.set(name, handler)),
  };
  plugin.register(api as any);
  return { events, api };
}

describe("date-mode media adapter behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not attach media to date-mode pre-reply blocks", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ media: { url: "https://cdn.test/pre.png" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { events } = setup();

    const result = await events.get("reply_payload_sending")?.({
      kind: "block",
      payload: { text: "text continues", channelData: { mode: "date" } },
    }, { channelId: "date-channel", replyToBody: "date-mode user message" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
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
      kind: "final",
      payload: {
        text: "focused text that used to be rewritten",
        to: "channel:date-channel",
        channelData: { mode: "date" },
      },
    }, { messageId: "msg-1" });

    expect(fetchMock).toHaveBeenCalledWith("https://hent.test/v1/final-response/verdict", expect.objectContaining({ method: "POST" }));
    expect(result).toMatchObject({ payload: { mediaUrl: "https://cdn.test/service-choice.png" } });
  });

  it("does not register sent-message watcher or legacy local patching", () => {
    const { api, events } = setup();
    expect(events.get("message_sent")).toBeUndefined();
    expect(api.on).not.toHaveBeenCalledWith("message_sent", expect.any(Function), { name: "hent-ai-message-sent-media" });
    expect(api.on).not.toHaveBeenCalledWith("message_sent", expect.any(Function), { name: "emotion-image-message-sent" });
  });
});
