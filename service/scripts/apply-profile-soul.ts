import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ServiceDatabase } from "../src/db.js";

const MAX_SOUL_BYTES = 8192;

type ApplyProfileSoulOptions = {
  readonly dbPath: string;
  readonly profile: string;
  readonly filePath: string;
  readonly backupDir: string;
};

export type ApplyProfileSoulReceipt = {
  readonly profile: string;
  readonly oldBytes: number;
  readonly newBytes: number;
  readonly sha256: string;
  readonly backupPath: string;
  readonly updatedAt: string;
};

export function parseApplyProfileSoulArgs(args: readonly string[]): ApplyProfileSoulOptions {
  const values = new Map<string, string>();
  const required = new Set(["--db", "--profile", "--file", "--backup-dir"]);

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!required.has(flag) || value === undefined || values.has(flag)) {
      throw new Error("Usage: apply-profile-soul --db <path> --profile <id> --file <path> --backup-dir <path>");
    }
    values.set(flag, value);
  }

  if (args.length !== required.size * 2 || [...required].some((flag) => !values.get(flag)?.trim())) {
    throw new Error("Usage: apply-profile-soul --db <path> --profile <id> --file <path> --backup-dir <path>");
  }

  return {
    dbPath: values.get("--db")!,
    profile: values.get("--profile")!,
    filePath: values.get("--file")!,
    backupDir: values.get("--backup-dir")!,
  };
}

export function applyProfileSoul(options: ApplyProfileSoulOptions): ApplyProfileSoulReceipt {
  const dbPath = regularFile(options.dbPath, "database");
  const filePath = regularFile(options.filePath, "soul file");
  const profile = options.profile.trim();
  if (!profile) throw new Error("Profile is required");

  const soul = normalizeSoul(readFileSync(filePath, "utf8"));
  const database = new ServiceDatabase(dbPath);

  try {
    const current = database.getProfile(profile);
    if (!current) throw new Error(`Profile not found: ${profile}`);

    const oldSoul = current.soulSnippet ?? "";
    const backupDir = prepareBackupDirectory(options.backupDir);
    const updatedAt = new Date().toISOString();
    const backupPath = backupPathFor(backupDir, profile, updatedAt);
    writeFileSync(backupPath, oldSoul, { encoding: "utf8", flag: "wx", mode: 0o600 });

    database.db.transaction(() => {
      database.db.prepare("UPDATE profiles SET soul_snippet = ?, updated_at = ? WHERE id = ?")
        .run(soul, updatedAt, profile);
      const saved = database.db.prepare("SELECT soul_snippet, updated_at FROM profiles WHERE id = ?")
        .get(profile) as { soul_snippet: string | null; updated_at: string } | undefined;
      if (!saved || saved.soul_snippet !== soul || saved.updated_at !== updatedAt) {
        throw new Error("Profile soul verification failed");
      }
    })();

    return {
      profile,
      oldBytes: Buffer.byteLength(oldSoul, "utf8"),
      newBytes: Buffer.byteLength(soul, "utf8"),
      sha256: sha256(soul),
      backupPath,
      updatedAt,
    };
  } finally {
    database.close();
  }
}

export function runApplyProfileSoulCli(args: readonly string[], output: (line: string) => void = console.log): ApplyProfileSoulReceipt {
  const receipt = applyProfileSoul(parseApplyProfileSoulArgs(args));
  output(JSON.stringify(receipt));
  return receipt;
}

function normalizeSoul(content: string): string {
  const normalized = content.normalize("NFC").trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes < 1 || bytes > MAX_SOUL_BYTES) {
    throw new Error(`Soul content must be between 1 and ${MAX_SOUL_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

function regularFile(path: string, label: string): string {
  const resolved = resolve(path);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`Invalid ${label} path: ${path}`);
  }
  if (!stat.isFile()) throw new Error(`Invalid ${label} path: ${path}`);
  return resolved;
}

function prepareBackupDirectory(path: string): string {
  const resolved = resolve(path);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (!statSync(resolved).isDirectory()) throw new Error(`Invalid backup directory: ${path}`);
  return resolved;
}

function backupPathFor(backupDir: string, profile: string, updatedAt: string): string {
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, "_");
  const timestamp = updatedAt.replace(/[:.]/g, "-");
  return resolve(backupDir, `${safeProfile}-${timestamp}.txt`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runApplyProfileSoulCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to apply profile soul");
    process.exitCode = 1;
  }
}
