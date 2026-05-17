#!/usr/bin/env npx tsx
import { resolve } from "node:path";
import { loadChannelOverrides, saveChannelOverrides } from "../assets/channel-overrides.js";

const args = process.argv.slice(2);

function usage(): never {
  console.error(`Usage: set_channel_mode --channel <id> --mode <set-id|default> [--image-dir <path>]`);
  process.exit(1);
}

let channelId: string | undefined;
let mode: string | undefined;
let imageDir: string | undefined;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--channel":
      channelId = args[++i];
      break;
    case "--mode":
      mode = args[++i];
      break;
    case "--image-dir":
      imageDir = args[++i];
      break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      usage();
  }
}

if (!channelId || !mode) usage();

const dir = imageDir ?? resolve(import.meta.dirname ?? ".", "../../assets");

async function main() {
  const overrides = await loadChannelOverrides(dir);

  if (mode === "default") {
    delete overrides[channelId!];
    console.log(`Channel ${channelId}: reverted to default set`);
  } else {
    overrides[channelId!] = mode!;
    console.log(`Channel ${channelId}: set to "${mode}"`);
  }

  await saveChannelOverrides(dir, overrides);
  console.log(`Saved to ${resolve(dir, "channel-overrides.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
