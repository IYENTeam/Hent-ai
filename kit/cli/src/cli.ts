#!/usr/bin/env bun
// hent - Hent-ai session kit CLI.

import { runBridgeCli } from "./bridge/index.ts";
import { cmdAsset, cmdBridgeInstall, cmdChannels, cmdHistory, cmdInbox, cmdMedia, cmdMemory, cmdSend, cmdSession, cmdSkip, cmdTyping } from "./commands.ts";

const IMPLEMENTED: ReadonlySet<string> = new Set(["bridge", "session", "send", "skip", "media", "asset", "typing", "channels", "memory", "inbox", "history"]);

const SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["bridge", "run the token-owning Discord bridge"],
  ["session", "register the session that receives inbound messages"],
  ["send", "send a reply (with emotion media) through the bridge"],
  ["skip", "mark an inbound message handled without replying"],
  ["media", "fetch the emotion image for a reply"],
  ["asset", "register a generated image in the channel's asset set"],
  ["typing", "show the typing indicator in a channel"],
  ["channels", "list and configure bridged channels"],
  ["memory", "read and write session memory"],
  ["inbox", "drain a native wake with next/done, or inspect --tail"],
  ["history", "show recent journal events for a channel"],
];

const usage = (): string => {
  const width = Math.max(...SUBCOMMANDS.map(([name]) => name.length));
  return ["usage: hent <command> [options]", "", "commands:", ...SUBCOMMANDS.map(([name, desc]) => `  ${name.padEnd(width)}  ${desc}${IMPLEMENTED.has(name) ? "" : " (not yet implemented)"}`)].join("\n");
};

export const main = (argv: readonly string[]): number | Promise<number> => {
  const [cmd] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return 0;
  }
  const rest = argv.slice(1);
  switch (cmd) {
    case "bridge":
      return rest[0] === "install" ? cmdBridgeInstall() : runBridgeCli(rest);
    case "send":
      return cmdSend(rest);
    case "media":
      return cmdMedia(rest);
    case "asset":
      return cmdAsset(rest);
    case "typing":
      return cmdTyping(rest);
    case "skip":
      return cmdSkip(rest);
    case "session":
      return cmdSession(rest);
    case "inbox":
      return cmdInbox(rest);
    case "history":
      return cmdHistory(rest);
    case "channels":
      return cmdChannels(rest);
    case "memory":
      return cmdMemory(rest);
  }
  if (SUBCOMMANDS.some(([name]) => name === cmd)) {
    console.error(`hent ${cmd}: not yet implemented`);
    return 2;
  }
  console.error(`hent: unknown command "${cmd}"\n\n${usage()}`);
  return 2;
};

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
