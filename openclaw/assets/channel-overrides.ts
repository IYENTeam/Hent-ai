import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const OVERRIDES_FILENAME = "channel-overrides.json";

export interface ChannelOverrides {
  [channelId: string]: string;
}

export function loadChannelOverridesSync(imageDir: string): ChannelOverrides {
  const filePath = resolve(imageDir, OVERRIDES_FILENAME);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ChannelOverrides;
  } catch {
    return {};
  }
}

export async function loadChannelOverrides(imageDir: string): Promise<ChannelOverrides> {
  const filePath = resolve(imageDir, OVERRIDES_FILENAME);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as ChannelOverrides;
  } catch {
    return {};
  }
}

export async function saveChannelOverrides(
  imageDir: string,
  overrides: ChannelOverrides,
): Promise<void> {
  const filePath = resolve(imageDir, OVERRIDES_FILENAME);
  await writeFile(filePath, JSON.stringify(overrides, null, 2) + "\n", "utf-8");
}
