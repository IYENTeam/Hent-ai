import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function existingPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function rejectSymlink(path: string): void {
  if (existingPath(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("SQLite database path must not be a symbolic link");
  }
}

export function prepareDatabasePath(path: string): void {
  const filePath = resolve(path);
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) rejectSymlink(candidate);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

/** Recheck after SQLite opens because sidecars can appear between preflight and WAL setup. */
export function secureDatabaseFiles(path: string): void {
  const filePath = resolve(path);
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    rejectSymlink(candidate);
    if (existingPath(candidate)) chmodSync(candidate, 0o600);
  }
}
