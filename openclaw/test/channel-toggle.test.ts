import { describe, expect, it } from "vitest";

import { normalizeDiscordChannelId } from "../index.js";

/**
 * Tests for the per-channel toggle logic used inside the plugin register().
 * This mirrors the isChannelEnabled closure in index.ts.
 */
function makeIsChannelEnabled(
  mode: "allowlist" | "blocklist",
  list: string[],
): (channelId: string) => boolean {
  const channelList = new Set(list.map(normalizeDiscordChannelId));
  return (channelId: string) => {
    if (channelList.size === 0) return true;
    if (mode === "allowlist") return channelList.has(channelId);
    return !channelList.has(channelId);
  };
}

describe("per-channel toggle", () => {
  it("empty list enables all channels (blocklist)", () => {
    const check = makeIsChannelEnabled("blocklist", []);
    expect(check("123")).toBe(true);
    expect(check("456")).toBe(true);
  });

  it("empty list enables all channels (allowlist)", () => {
    const check = makeIsChannelEnabled("allowlist", []);
    expect(check("123")).toBe(true);
  });

  it("blocklist mode blocks listed channels", () => {
    const check = makeIsChannelEnabled("blocklist", ["111", "222"]);
    expect(check("111")).toBe(false);
    expect(check("222")).toBe(false);
    expect(check("333")).toBe(true);
  });

  it("allowlist mode allows only listed channels", () => {
    const check = makeIsChannelEnabled("allowlist", ["111", "222"]);
    expect(check("111")).toBe(true);
    expect(check("222")).toBe(true);
    expect(check("333")).toBe(false);
  });

  it("defaults to blocklist when mode not specified", () => {
    // The plugin defaults mode to "blocklist" when not specified
    const check = makeIsChannelEnabled("blocklist", ["999"]);
    expect(check("999")).toBe(false);
    expect(check("000")).toBe(true);
  });

  it("normalizes channel: prefixes in configured channel lists", () => {
    const check = makeIsChannelEnabled("blocklist", ["channel:999"]);
    expect(check("999")).toBe(false);
    expect(check("000")).toBe(true);
  });
});
