import { describe, expect, it } from "vitest";

import { createChannelEnabledResolver, normalizeDiscordChannelId } from "../channel-filter.js";

describe("per-channel toggle", () => {
  it("defaults to enabled when no channel policy exists", () => {
    const check = createChannelEnabledResolver();
    expect(check("123")).toBe(true);
    expect(check("456")).toBe(true);
  });

  it("uses defaultEnabled for channels without explicit overrides", () => {
    const check = createChannelEnabledResolver({ defaultEnabled: false });
    expect(check("123")).toBe(false);
  });

  it("uses explicit config overrides as the preferred config shape", () => {
    const check = createChannelEnabledResolver({
      defaultEnabled: true,
      overrides: {
        "111": false,
        "channel:222": true,
      },
    });

    expect(check("111")).toBe(false);
    expect(check("222")).toBe(true);
    expect(check("333")).toBe(true);
  });

  it("lets DB channel settings override config policy", () => {
    const check = createChannelEnabledResolver(
      { defaultEnabled: true, overrides: { "111": true } },
      { getChannelEnabled: (channelId) => (channelId === "111" ? false : null) },
    );

    expect(check("111")).toBe(false);
    expect(check("222")).toBe(true);
  });

  it("legacy blocklist mode blocks listed channels", () => {
    const check = createChannelEnabledResolver({ mode: "blocklist", list: ["111", "222"] });
    expect(check("111")).toBe(false);
    expect(check("222")).toBe(false);
    expect(check("333")).toBe(true);
  });

  it("legacy allowlist mode allows only listed channels", () => {
    const check = createChannelEnabledResolver({ mode: "allowlist", list: ["111", "222"] });
    expect(check("111")).toBe(true);
    expect(check("222")).toBe(true);
    expect(check("333")).toBe(false);
  });

  it("preserves legacy empty-list behavior as all channels enabled", () => {
    const allowlist = createChannelEnabledResolver({ mode: "allowlist", list: [] });
    const blocklist = createChannelEnabledResolver({ mode: "blocklist", list: [] });

    expect(allowlist("123")).toBe(true);
    expect(blocklist("123")).toBe(true);
  });

  it("uses defaultEnabled for an explicit all-off policy", () => {
    const check = createChannelEnabledResolver({ defaultEnabled: false, overrides: {} });
    expect(check("123")).toBe(false);
  });

  it("normalizes channel: prefixes in configured channel lists", () => {
    const check = createChannelEnabledResolver({ mode: "blocklist", list: ["channel:999"] });
    expect(check("999")).toBe(false);
    expect(check("000")).toBe(true);
  });

  it("normalizes Discord channel IDs correctly", () => {
    expect(normalizeDiscordChannelId("channel:123456789")).toBe("123456789");
    expect(normalizeDiscordChannelId("123456789")).toBe("123456789");
  });
});
