#!/usr/bin/env node

import { run as generate } from "./cli.js";
import { runSets } from "./sets.js";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
hent-ai v${VERSION}

Usage:
  hent-ai <command> [options]

Commands:
  generate    Generate emotion images from a character description
  sets        Manage emotion image asset sets

Run 'hent-ai <command> --help' for command-specific options.
`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "generate":
    case "gen":
      await generate(rest);
      break;
    case "sets":
    case "set":
      await runSets(rest);
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

main();
