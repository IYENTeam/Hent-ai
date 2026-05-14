#!/usr/bin/env node

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { generateAllEmotions, EMOTIONS } from "./generator.js";

interface CliArgs {
  prompt: string;
  outputDir: string;
  model?: string;
  size?: string;
  reference?: string;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    return null;
  }

  let prompt = "";
  let outputDir = resolve("assets");
  let model: string | undefined;
  let size: string | undefined;
  let reference: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--prompt":
      case "-p":
        prompt = next ?? "";
        i++;
        break;
      case "--output":
      case "-o":
        outputDir = resolve(next ?? "assets");
        i++;
        break;
      case "--model":
      case "-m":
        model = next;
        i++;
        break;
      case "--size":
      case "-s":
        size = next;
        i++;
        break;
      case "--reference":
      case "-r":
        reference = next;
        i++;
        break;
      default:
        if (!prompt && !arg.startsWith("-")) {
          prompt = arg;
        }
        break;
    }
  }

  if (!prompt) return null;

  return { prompt, outputDir, model, size, reference };
}

function printUsage(): void {
  console.log(`
hent-ai-generate — Generate 6 emotion images using Codex

Usage:
  hent-ai-generate --prompt "cute orange cat character"
  hent-ai-generate -p "pixel art robot" -o ./my-assets
  hent-ai-generate -p "anime girl" -r ./base-character.png

Options:
  -p, --prompt <text>       Base character description (required)
  -o, --output <dir>        Output directory (default: ./assets)
  -m, --model <model>       Codex model (default: gpt-5.4)
  -s, --size <WxH>          Image size (default: 1024x1024)
  -r, --reference <path>    Reference image for style consistency
  -h, --help                Show this help

Prerequisites:
  Log in with Codex CLI first: codex login
  Auth is read from ~/.codex/auth.json

Output:
  Creates ${EMOTIONS.join(", ")}.png in the output directory.
`);
}

async function loadReferenceImage(path: string): Promise<string> {
  const buf = await readFile(resolve(path));
  const ext = path.split(".").pop()?.toLowerCase() ?? "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exit(parsed === null ? 1 : 0);
  }

  const { prompt, outputDir, model, size, reference } = parsed;

  let referenceImage: string | undefined;
  if (reference) {
    try {
      referenceImage = await loadReferenceImage(reference);
      console.log(`Using reference image: ${reference}`);
    } catch (err) {
      console.error(`Failed to load reference image: ${reference}`);
      process.exit(1);
    }
  }

  console.log(`Generating 6 emotion images for: "${prompt}"`);
  console.log(`Output: ${outputDir}\n`);

  try {
    const results = await generateAllEmotions({
      prompt,
      outputDir,
      model,
      size,
      referenceImage,
      onProgress(emotion, index, total) {
        console.log(`[${index + 1}/${total}] Generating ${emotion}...`);
      },
    });

    console.log(`\nDone! Generated ${results.size} images:`);
    for (const [emotion, path] of results) {
      console.log(`  ${emotion} → ${path}`);
    }
  } catch (err) {
    console.error(
      `\nGeneration failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

main();
