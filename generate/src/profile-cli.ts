import { resolve } from "node:path";
import { ProfileDatabase } from "@hent-ai/shared/db";
import type { ProfileMode } from "@hent-ai/shared/profile";

function usage(): never {
  console.log(`
hent-ai profile <command> [options]

Commands:
  create      Create a new profile
  list        List all profiles
  delete      Delete a profile
  set-soul    Set a profile's soul snippet (work mode persona)
  set-chat    Set a profile's chat prompt (date mode persona)
  set-mode    Set profile mode (default or date)
  show        Show profile details

Options:
  --id <id>             Profile ID (slug)
  --name <name>         Display name
  --character <desc>    Character description
  --text <snippet>      Text content (soul snippet, chat prompt, etc.)
  --mode <mode>         Profile mode: "default" or "date"
  --image-dir <path>    Image directory (default: ./assets)
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      result[argv[i].slice(2)] = argv[++i];
    }
  }
  return result;
}

export async function runProfile(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const imageDir = resolve(args["image-dir"] ?? "./assets");
  const db = new ProfileDatabase(imageDir);

  try {
    switch (command) {
      case "create": {
        if (!args.id || !args.name) {
          console.error("Required: --id and --name");
          process.exit(1);
        }
        const mode = (args.mode as ProfileMode) ?? "default";
        const profile = db.createProfile({
          id: args.id,
          name: args.name,
          character: args.character,
          soulSnippet: mode === "default" ? args.text : undefined,
          chatPrompt: mode === "date" ? args.text : undefined,
          mode,
        });
        console.log(`Created profile: ${profile.id} (${profile.name})`);
        break;
      }
      case "list": {
        const profiles = db.listProfiles();
        if (profiles.length === 0) {
          console.log("No profiles found.");
        } else {
          console.log(`${"ID".padEnd(20)} ${"Name".padEnd(20)} ${"Mode".padEnd(10)} ${"Created"}`);
          console.log("-".repeat(75));
          for (const p of profiles) {
            console.log(`${p.id.padEnd(20)} ${p.name.padEnd(20)} ${p.mode.padEnd(10)} ${p.createdAt}`);
          }
        }
        break;
      }
      case "delete": {
        if (!args.id) {
          console.error("Required: --id");
          process.exit(1);
        }
        const deleted = db.deleteProfile(args.id);
        console.log(deleted ? `Deleted profile: ${args.id}` : `Profile not found: ${args.id}`);
        break;
      }
      case "set-soul": {
        if (!args.id || !args.text) {
          console.error("Required: --id and --text");
          process.exit(1);
        }
        db.updateProfile(args.id, { soulSnippet: args.text });
        console.log(`Updated soul snippet for: ${args.id}`);
        break;
      }
      case "set-chat": {
        if (!args.id || !args.text) {
          console.error("Required: --id and --text");
          process.exit(1);
        }
        db.updateProfile(args.id, { chatPrompt: args.text });
        console.log(`Updated chat prompt for: ${args.id}`);
        break;
      }
      case "set-mode": {
        if (!args.id || !args.mode) {
          console.error("Required: --id and --mode (default or date)");
          process.exit(1);
        }
        if (args.mode !== "default" && args.mode !== "date") {
          console.error(`Invalid mode: "${args.mode}" (must be "default" or "date")`);
          process.exit(1);
        }
        db.updateProfile(args.id, { mode: args.mode as ProfileMode });
        console.log(`Set mode for ${args.id}: ${args.mode}`);
        break;
      }
      case "show": {
        if (!args.id) {
          console.error("Required: --id");
          process.exit(1);
        }
        const profile = db.getProfile(args.id);
        if (!profile) {
          console.error(`Profile not found: ${args.id}`);
          process.exit(1);
        }
        console.log(JSON.stringify(profile, null, 2));
        break;
      }
      default:
        usage();
    }
  } finally {
    db.close();
  }
}
