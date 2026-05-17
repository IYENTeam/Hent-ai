import { resolve } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
import {
  loadManifest,
  saveManifest,
  createEmptyManifest,
  registerSet,
  activateSet,
  listSets,
  getSetDir,
  type AssetManifest,
} from "../../openclaw/assets/manifest.js";

function printSetsUsage(): void {
  console.log(`
hent-ai sets — Manage emotion image asset sets

Usage:
  hent-ai sets list                          List all sets
  hent-ai sets active                        Show active set
  hent-ai sets switch <set-id>               Switch active set
  hent-ai sets register <set-id> [options]   Register a set from existing images
  hent-ai sets info <set-id>                 Show set details

Options (register):
  --name <name>           Human-readable set name
  --character <text>      Character description
  --model <model>         Generation model used
  --dir <path>            Asset root directory (default: ./assets)

Examples:
  hent-ai sets list
  hent-ai sets switch gothic-v2
  hent-ai sets register gothic-v2 --name "Gothic Girl v2" --character "anime girl..."
`);
}

async function ensureManifest(assetDir: string): Promise<AssetManifest> {
  const existing = await loadManifest(assetDir);
  if (existing) return existing;
  const fresh = createEmptyManifest();
  await saveManifest(assetDir, fresh);
  return fresh;
}

export async function runSets(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printSetsUsage();
    return;
  }

  let assetDir = resolve("assets");
  const dirIdx = args.indexOf("--dir");
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    assetDir = resolve(args[dirIdx + 1]);
  }

  const manifest = await ensureManifest(assetDir);

  switch (subcommand) {
    case "list": {
      const sets = listSets(manifest);
      if (sets.length === 0) {
        console.log("No asset sets registered.");
        return;
      }
      console.log("Asset Sets:\n");
      for (const s of sets) {
        const marker = s.active ? " ★ (active)" : "";
        console.log(`  ${s.id}${marker}`);
        console.log(`    Name: ${s.name}`);
        console.log(`    Emotions: ${s.emotionCount} types, ${s.totalFiles} files`);
        console.log(`    Created: ${s.createdAt}`);
        console.log();
      }
      break;
    }

    case "active": {
      if (!manifest.activeSet || !manifest.sets[manifest.activeSet]) {
        console.log("No active set configured.");
        return;
      }
      const set = manifest.sets[manifest.activeSet];
      console.log(`Active set: ${manifest.activeSet}`);
      console.log(`  Name: ${set.name}`);
      console.log(`  Character: ${set.character ?? "(not set)"}`);
      console.log(`  Model: ${set.model ?? "(not set)"}`);
      console.log(`  Created: ${set.createdAt}`);
      console.log(`  Emotions:`);
      for (const [emotion, files] of Object.entries(set.emotions)) {
        console.log(`    ${emotion}: ${files.join(", ")}`);
      }
      break;
    }

    case "switch": {
      const setId = args[1];
      if (!setId) {
        console.error("Usage: hent-ai sets switch <set-id>");
        process.exit(1);
      }
      if (!manifest.sets[setId]) {
        console.error(`Set "${setId}" not found. Available: ${Object.keys(manifest.sets).join(", ")}`);
        process.exit(1);
      }
      await activateSet(assetDir, manifest, setId);
      console.log(`✅ Switched to set "${setId}" (${manifest.sets[setId].name})`);
      console.log("Root emotion files updated for backward compatibility.");
      break;
    }

    case "register": {
      const setId = args[1];
      if (!setId) {
        console.error("Usage: hent-ai sets register <set-id> --name <name>");
        process.exit(1);
      }

      let name = setId;
      let character: string | undefined;
      let model: string | undefined;

      for (let i = 2; i < args.length; i++) {
        switch (args[i]) {
          case "--name":
            name = args[++i] ?? setId;
            break;
          case "--character":
            character = args[++i];
            break;
          case "--model":
            model = args[++i];
            break;
        }
      }

      const setDir = getSetDir(assetDir, setId);
      await mkdir(setDir, { recursive: true });

      const set = await registerSet(assetDir, manifest, setId, { name, character, model });
      const totalFiles = Object.values(set.emotions).reduce((sum, f) => sum + f.length, 0);
      console.log(`✅ Registered set "${setId}"`);
      console.log(`  Name: ${name}`);
      console.log(`  Emotions: ${Object.keys(set.emotions).length} types, ${totalFiles} files`);

      if (!manifest.activeSet) {
        manifest.activeSet = setId;
        await saveManifest(assetDir, manifest);
        console.log(`  Set as active (first set registered).`);
      }
      break;
    }

    case "info": {
      const setId = args[1];
      if (!setId || !manifest.sets[setId]) {
        console.error(`Set "${setId ?? ""}" not found.`);
        process.exit(1);
      }
      const set = manifest.sets[setId];
      const isActive = manifest.activeSet === setId;
      console.log(`Set: ${setId}${isActive ? " ★ (active)" : ""}`);
      console.log(`  Name: ${set.name}`);
      console.log(`  Character: ${set.character ?? "(not set)"}`);
      console.log(`  Model: ${set.model ?? "(not set)"}`);
      console.log(`  Created: ${set.createdAt}`);
      console.log(`  Emotions:`);
      for (const [emotion, files] of Object.entries(set.emotions)) {
        console.log(`    ${emotion}: ${files.join(", ")}`);
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printSetsUsage();
      process.exit(1);
  }
}
