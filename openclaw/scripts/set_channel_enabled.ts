#!/usr/bin/env npx tsx
import { resolve } from "node:path";
import { ProfileDatabase } from "@hent-ai/shared/db";

const args = process.argv.slice(2);

function usage(): never {
  console.error(`Usage: set_channel_enabled --channel <id> --enabled <true|false|default> [--image-dir <path>]`);
  process.exit(1);
}

let channelId: string | undefined;
let enabled: string | undefined;
let imageDir: string | undefined;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--channel":
      channelId = args[++i];
      break;
    case "--enabled":
      enabled = args[++i];
      break;
    case "--image-dir":
      imageDir = args[++i];
      break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      usage();
  }
}

if (!channelId || !enabled) usage();

const normalized = enabled.toLowerCase();
if (!["true", "false", "default"].includes(normalized)) usage();

const dir = imageDir ?? resolve(import.meta.dirname ?? ".", "../../assets");
const db = new ProfileDatabase(dir);

try {
  if (normalized === "default") {
    db.removeChannelEnabled(channelId);
    console.log(`Channel ${channelId}: reverted to default enabled policy`);
  } else {
    const nextEnabled = normalized === "true";
    db.setChannelEnabled(channelId, nextEnabled);
    console.log(`Channel ${channelId}: Hent-ai ${nextEnabled ? "enabled" : "disabled"}`);
  }

  console.log(`Saved to ${resolve(dir, "hentai.db")} (channel_settings)`);
} finally {
  db.close();
}
