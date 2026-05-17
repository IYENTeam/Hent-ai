import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "../index.js";

describe("focused thinking image pools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("selects a fresh focused variant for each message_received event", async () => {
    const imageDir = mkdtempSync(join(tmpdir(), "hent-openclaw-focused-"));
    writeFileSync(join(imageDir, "focused-a.png"), "a");
    writeFileSync(join(imageDir, "focused-b.png"), "b");

    const events = new Map<string, (event: unknown) => Promise<void>>();
    const fetchMock = vi.fn(async (_url: string, options: { body: { toString(): string } }) => ({
      ok: true,
      text: async () => "",
      body: options.body,
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9);

    plugin.register({
      pluginConfig: {
        imageDir,
        discordToken: "token",
        cheer: { enabled: false },
        emotionMap: {
          focused: ["focused-a.png", "focused-b.png"],
        },
      },
      runtime: { config: { current: () => ({}) } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(name: string, handler: (event: unknown) => Promise<void>) {
        events.set(name, handler);
      },
    });

    const handler = events.get("message_received");
    expect(handler).toBeDefined();

    const event = {
      content: "debugging this issue",
      metadata: { to: "channel:123456789012345678" },
    };
    await handler?.(event);
    await handler?.(event);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body.toString()).toContain("focused-a.png");
    expect(fetchMock.mock.calls[1][1].body.toString()).toContain("focused-b.png");
  });
});
