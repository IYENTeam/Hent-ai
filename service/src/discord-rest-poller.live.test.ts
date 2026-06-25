import { describe, expect, it } from "vitest";
import { fetchChannelMessages, sendChannelMessage } from "./discord-rest-poller.js";

type LiveDiscordConfig = {
  readonly token: string;
  readonly channelId: string;
  readonly sendContent?: string;
};

const liveConfig = readLiveDiscordConfig(process.env);
const describeLive = liveConfig ? describe : describe.skip;

describeLive("Discord REST live verification", () => {
  it("fetches real Discord channel messages with the configured bot token", async () => {
    if (!liveConfig) throw new Error("live Discord config was not loaded");

    const messages = await fetchChannelMessages(liveConfig.token, liveConfig.channelId, { limit: 1 });

    expect(Array.isArray(messages)).toBe(true);
  });

  it("optionally sends a real Discord message when send content is configured", async () => {
    if (!liveConfig) throw new Error("live Discord config was not loaded");
    if (!liveConfig.sendContent) return;

    const messageId = await sendChannelMessage(liveConfig.token, liveConfig.channelId, liveConfig.sendContent);

    expect(messageId).toEqual(expect.stringMatching(/^\\d+$/));
  });
});

function readLiveDiscordConfig(env: NodeJS.ProcessEnv): LiveDiscordConfig | null {
  const token = stringEnv(env.HENT_AI_DISCORD_POLLER_TOKEN) ?? stringEnv(env.DISCORD_BOT_TOKEN);
  const [channelId] = stringEnv(env.HENT_AI_DISCORD_POLLER_CHANNELS)?.split(",").map((channel) => channel.trim()).filter(Boolean) ?? [];
  if (!token || !channelId) return null;
  return {
    token,
    channelId,
    sendContent: stringEnv(env.HENT_AI_DISCORD_POLLER_LIVE_SEND_CONTENT),
  };
}

function stringEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
