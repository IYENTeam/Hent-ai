import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileDatabase } from "@hent-ai/shared/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "../index.js";
import { closeProfileDatabase } from "../profile-manager.js";

describe("onboarding lock", () => {
  let imageDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    closeProfileDatabase();
    if (imageDir) {
      await rm(imageDir, { recursive: true, force: true });
      imageDir = undefined;
    }
  });

  it("suppresses outbound emotion attachment when the active private profile is onboarding", async () => {
    imageDir = await mkdtemp(join(tmpdir(), "hent-openclaw-onboarding-"));
    const privateDir = join(imageDir, "profiles", "private");
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(privateDir, "happy.png"), "happy");
    writeFileSync(join(privateDir, ".onboarding-active"), "");

    const db = new ProfileDatabase(imageDir);
    db.createProfile({ id: "private", name: "Private" });
    db.setChannelProfile("123456789012345678", "private");
    db.close();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const events = new Map<string, (event: unknown) => Promise<void>>();
    plugin.register({
      pluginConfig: {
        imageDir,
        discordToken: "token",
        cheer: { enabled: false },
      },
      runtime: { config: { current: () => ({}) } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(name: string, handler: (event: unknown) => Promise<void>) {
        events.set(name, handler);
      },
    });

    await events.get("message_sent")?.({
      to: "channel:123456789012345678",
      content: "Task completed successfully",
      success: true,
      messageId: "987654321098765432",
    });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
