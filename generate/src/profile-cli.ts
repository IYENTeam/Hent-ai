import { resolve } from "node:path";
import { ProfileDatabase } from "@hent-ai/shared/db";

function usage(): never {
  console.log(`
hent-ai profile <command> [options]

Commands:
  create    Create a new profile
  list      List all profiles
  delete    Delete a profile
  set-soul  Set a profile's soul snippet
  show      Show profile details

Options:
  --id <id>           Profile ID (slug)
  --name <name>       Display name
  --character <desc>  Character description
  --text <snippet>    Soul snippet text
  --image-dir <path>  Image directory (default: ./assets)
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
        const profile = db.createProfile({
          id: args.id,
          name: args.name,
          character: args.character,
          soulSnippet: args.text,
        });
        console.log(`Created profile: ${profile.id} (${profile.name})`);
        break;
      }
      case "list": {
        const profiles = db.listProfiles();
        if (profiles.length === 0) {
          console.log("No profiles found.");
        } else {
          console.log(`${"ID".padEnd(20)} ${"Name".padEnd(25)} ${"Created"}`);
          console.log("-".repeat(65));
          for (const p of profiles) {
            console.log(`${p.id.padEnd(20)} ${p.name.padEnd(25)} ${p.createdAt}`);
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
