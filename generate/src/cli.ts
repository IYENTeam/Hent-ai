import { resolve } from "node:path";
import { generateAllEmotions, EMOTIONS, type Emotion } from "./generator.js";

const MAX_CHARACTER_LENGTH = 1000;
const SIZE_PATTERN = /^\d+x\d+$/;

interface CliArgs {
  character: string;
  outputDir: string;
  model?: string;
  size?: string;
  baseImage?: string;
  keepBase: boolean;
  only?: Emotion[];
}

export function parseArgs(args: string[]): CliArgs | null {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    return null;
  }

  let character = "";
  let outputDir = resolve("assets");
  let model: string | undefined;
  let size: string | undefined;
  let baseImage: string | undefined;
  let keepBase = true;
  let only: Emotion[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--character":
      case "-c":
        character = next ?? "";
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
      case "--base":
      case "-b":
        baseImage = next;
        i++;
        break;
      case "--no-keep-base":
        keepBase = false;
        break;
      case "--only":
        only = (next ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Emotion[];
        i++;
        break;
      default:
        if (!character && !arg.startsWith("-")) {
          character = arg;
        }
        break;
    }
  }

  if (!character) return null;

  if (character.length > MAX_CHARACTER_LENGTH) {
    console.error(
      `--character is too long (${character.length} chars; max ${MAX_CHARACTER_LENGTH}).`,
    );
    return null;
  }

  if (size !== undefined && !SIZE_PATTERN.test(size)) {
    console.error(`Invalid --size "${size}". Expected WxH, e.g. 1024x1024.`);
    return null;
  }

  if (only?.length) {
    const invalid = only.filter((e) => !(EMOTIONS as readonly string[]).includes(e));
    if (invalid.length) {
      console.error(`Invalid emotions: ${invalid.join(", ")}\nValid: ${EMOTIONS.join(", ")}`);
      return null;
    }
  }

  return { character, outputDir, model, size, baseImage, keepBase, only };
}

function printUsage(): void {
  console.log(`
hent-ai generate — Generate 6 emotion images using Codex

Usage:
  hent-ai generate --character "cute orange cat"
  hent-ai generate -c "pixel art robot" -o ./my-assets
  hent-ai generate -c "anime girl" -b ./base-character.png

Options:
  -c, --character <text>    Character description (required)
  -b, --base <path>         Existing base image (skips base generation)
  -o, --output <dir>        Output directory (default: ./assets)
  -m, --model <model>       Codex model (default: gpt-5.4)
  -s, --size <WxH>          Image size (default: 1024x1024)
      --no-keep-base        Don't save base.png to output directory
      --only <emotions>     Regenerate specific emotions only (comma-separated)
                            e.g. --only sorry,confused
  -h, --help                Show this help

Flow:
  1. Generates a base character image (or uses --base if provided)
  2. Uses the base as reference to generate ${EMOTIONS.length} emotion variants
  3. Outputs: base.png + ${EMOTIONS.join(", ")}.png

Limits:
  - Max 3 reference images per request (auto-resized to 768px)
  - 90s timeout per generation call
  - Safety rephrase is NOT available in CLI mode (no LLM provider).
    Use OpenClaw onboarding for automatic prompt rephrasing on policy rejections.

Prerequisites:
  Log in with Codex CLI first: codex login
  Auth is read from ~/.codex/auth.json
`);
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const { character, outputDir, model, size, baseImage, keepBase, only } = parsed;

  console.log(`Generating emotion images for: "${character}"`);
  if (only?.length) {
    console.log(`Regenerating only: ${only.join(", ")}`);
  }
  if (baseImage) {
    console.log(`Using existing base: ${baseImage}`);
  } else {
    console.log("Generating base character image first...");
  }
  console.log(`Output: ${outputDir}\n`);

  try {
    const results = await generateAllEmotions({
      character,
      outputDir,
      model,
      size,
      baseImage,
      keepBase,
      only,
      onProgress(step, index, total) {
        console.log(`[${index + 1}/${total}] Generating ${step}...`);
      },
    });

    console.log(`\nDone! Generated ${results.size} images:`);
    for (const [name, path] of results) {
      console.log(`  ${name} → ${path}`);
    }
  } catch (err) {
    console.error(
      `\nGeneration failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
