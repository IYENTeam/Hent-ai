#!/usr/bin/env bun
// hent - Hent-ai session kit CLI. Subcommands are filled in by later todos of the
// session-owned-messenger plan; until then each one reports that it is not implemented.

const SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["bridge", "run the token-owning Discord bridge"],
  ["session", "register the session that receives inbound messages"],
  ["send", "send a reply (with emotion media) through the bridge"],
  ["skip", "mark an inbound message handled without replying"],
  ["media", "fetch the emotion image for a reply"],
  ["typing", "show the typing indicator in a channel"],
  ["channels", "list and configure bridged channels"],
  ["memory", "read and write session memory"],
  ["inbox", "read inbound events (debug long-poll)"],
  ["history", "show recent journal events for a channel"],
];

const usage = (): string => {
  const width = Math.max(...SUBCOMMANDS.map(([name]) => name.length));
  return ["usage: hent <command> [options]", "", "commands:", ...SUBCOMMANDS.map(([name, desc]) => `  ${name.padEnd(width)}  ${desc} (not yet implemented)`)].join("\n");
};

export const main = (argv: readonly string[]): number => {
  const [cmd] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return 0;
  }
  if (SUBCOMMANDS.some(([name]) => name === cmd)) {
    console.error(`hent ${cmd}: not yet implemented`);
    return 2;
  }
  console.error(`hent: unknown command "${cmd}"\n\n${usage()}`);
  return 2;
};

if (import.meta.main) process.exit(main(process.argv.slice(2)));
