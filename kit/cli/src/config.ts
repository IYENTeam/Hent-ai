import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HentConfig = {
  readonly enabled: boolean;
  /** Service base URL without trailing slash; undefined when unconfigured. */
  readonly url: string | undefined;
  /** Service API bearer; undefined when absent or unusable. */
  readonly token: string | undefined;
  /** Set when the token file exists but was refused (e.g. permissions too open). */
  readonly tokenProblem: string | undefined;
  /** Explicit fixed references; a missing override never falls back to another character. */
  readonly channelBaseImages?: Readonly<Record<string, string>>;
};

type Env = Readonly<Record<string, string | undefined>>;

export const hentHome = (env: Env = process.env): string => env.HENT_HOME || join(homedir(), ".hent");

const readLocalConfig = (home: string): { serviceUrl?: string; channelBaseImages?: Readonly<Record<string, string>> } => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const url = "serviceUrl" in parsed ? parsed.serviceUrl : undefined;
    const bases = "channelBaseImages" in parsed ? parsed.channelBaseImages : undefined;
    const channelBaseImages = typeof bases === "object" && bases !== null && !Array.isArray(bases)
      ? Object.fromEntries(Object.entries(bases).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return { ...(typeof url === "string" && url ? { serviceUrl: url } : {}), channelBaseImages };
  } catch {
    return {};
  }
};

const readToken = (home: string): { token?: string; problem?: string } => {
  const path = join(home, "service.token");
  if (!existsSync(path)) return {};
  try {
    if ((statSync(path).mode & 0o077) !== 0) return { problem: "service.token must be mode 0600" };
    const token = readFileSync(path, "utf8").trim();
    return token ? { token } : {};
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
};

export const loadConfig = (env: Env = process.env): HentConfig => {
  const home = hentHome(env);
  const local = readLocalConfig(home);
  const url = (env.HENT_URL || local.serviceUrl)?.replace(/\/+$/, "") || undefined;
  const envToken = env.HENT_SERVICE_TOKEN;
  const file = envToken ? {} : readToken(home);
  return {
    enabled: (env.HENT_ENABLED ?? "1").trim() !== "0",
    url,
    token: envToken || file.token,
    tokenProblem: file.problem,
    channelBaseImages: local.channelBaseImages,
  };
};
