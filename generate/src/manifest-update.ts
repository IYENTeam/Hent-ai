import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function updateManifestFile<T>(path: string, update: (current: T | null) => T): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5_000;
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Manifest is busy: ${path}. Retry after the current writer finishes; inspect an abandoned lock before removing it.`);
      await delay(10);
    }
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    let current: T | null = null;
    try { current = JSON.parse(await readFile(path, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = update(current);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    return next;
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await lock.close(); await rm(lockPath); }
  }
}
