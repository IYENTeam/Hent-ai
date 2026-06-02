import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import type { ServiceDatabase, StorageObjectInput } from "./db.js";

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checksumFile(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function contentTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

export function staticObjectUrl(storageKey: string): string {
  return `/static/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

export function storageKeyFromPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function objectInputFromFile(root: string, path: string, provenance = "imported"): StorageObjectInput {
  const storageKey = storageKeyFromPath(root, path);
  const stats = statSync(path);
  return {
    storageKey,
    objectUrl: staticObjectUrl(storageKey),
    contentHash: checksumFile(path),
    contentType: contentTypeForFilename(basename(path)),
    sizeBytes: stats.size,
    provenance,
    localPath: path,
  };
}

export function upsertStaticObject(db: ServiceDatabase, input: StorageObjectInput): number {
  return db.upsertStorageObject(input);
}
