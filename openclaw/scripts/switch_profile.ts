#!/usr/bin/env npx tsx
import { resolve } from "node:path";
import { ProfileDatabase } from "@hent-ai/shared/db";

const args = process.argv.slice(2);

function usage(): never {
  console.error("Usage: switch_profile --channel <id> --profile <profileId> [--image-dir <path>]");
  process.exit(1);
}

let channelId: string | undefined;
let profileId: string | undefined;
let imageDir: string | undefined;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--channel":
      channelId = args[++i];
      break;
    case "--profile":
      profileId = args[++i];
      break;
    case "--image-dir":
      imageDir = args[++i];
      break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      usage();
  }
}

if (!channelId || !profileId) usage();

const dir = imageDir ?? resolve(import.meta.dirname ?? ".", "../../assets");
const db = new ProfileDatabase(dir);

try {
  if (profileId === "default" || profileId === "none") {
    db.removeChannelProfile(channelId!);
    console.log(`Channel ${channelId}: reverted to default profile`);
  } else {
    const profile = db.getProfile(profileId!);
    if (!profile) {
      console.error(`Profile not found: "${profileId}"`);
      process.exit(1);
    }
    db.setChannelProfile(channelId!, profileId!);
    console.log(`Channel ${channelId}: switched to profile "${profileId}" (${profile.name})`);
  }
} finally {
  db.close();
}
