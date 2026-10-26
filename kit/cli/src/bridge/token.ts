// Bridge secrets (ADR-0002 "Token"): the Discord bot token and the local API bearer.
// The Discord token is never logged and never returned by any endpoint.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { type BridgePaths, writePrivateFile } from "./journal.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type TokenSource = "file" | "keychain" | "env";
export type TokenLookup = { readonly token: string; readonly source: TokenSource } | { readonly token: undefined; readonly problems: readonly string[] };
export type KeychainReader = () => Promise<string | undefined>;

/** macOS Keychain item `hent-discord` / account `hent`. An ssh login cannot unlock it, so it is opt-in. */
export const readKeychainToken: KeychainReader = async () => {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", "hent-discord", "-a", "hent", "-w"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out.trim() || undefined : undefined;
};

/**
 * Token sources in order: `~/.hent/discord.token` (refused unless group/other have no access),
 * the Keychain when `HENT_TOKEN_SOURCE=keychain`, then `HENT_DISCORD_TOKEN` (tests).
 */
export const readDiscordToken = async (paths: BridgePaths, env: Env, keychain: KeychainReader = readKeychainToken): Promise<TokenLookup> => {
  const problems: string[] = [];
  if (existsSync(paths.discordToken)) {
    if ((statSync(paths.discordToken).mode & 0o077) !== 0) problems.push("discord.token must be mode 0600");
    else {
      const token = readFileSync(paths.discordToken, "utf8").trim();
      if (token) return { token, source: "file" };
      problems.push("discord.token is empty");
    }
  }
  if (env.HENT_TOKEN_SOURCE === "keychain") {
    const token = await keychain();
    if (token) return { token, source: "keychain" };
    problems.push("keychain item hent-discord not readable");
  }
  const envToken = env.HENT_DISCORD_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env" };
  return { token: undefined, problems };
};

/** Returns the local API bearer, creating `bridge.secret` (0600) on first start. */
export const ensureBridgeSecret = (paths: BridgePaths): string => {
  if (existsSync(paths.secret)) {
    chmodSync(paths.secret, 0o600);
    const secret = readFileSync(paths.secret, "utf8").trim();
    if (secret) return secret;
  }
  const secret = randomBytes(32).toString("hex");
  writePrivateFile(paths.secret, `${secret}\n`);
  return secret;
};
