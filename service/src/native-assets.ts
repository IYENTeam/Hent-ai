import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { affectVectorFromDimensions, parseVisualAffectV2 } from "../../shared/affect.js";
import { CANONICAL_EMOTIONS } from "../../shared/emotions.js";
import type { ServiceDatabase } from "./db.js";
import { ServiceDatabaseSemanticAssetRepository } from "./semantic-assets/db-repository.js";
import { sha256Bytes, staticObjectUrl } from "./storage.js";

export class NativeAssetError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function imageExtension(contentType: unknown, bytes: Buffer): string | null {
  switch (contentType) {
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png" : null;
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpg" : null;
    case "image/webp":
      return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
    default:
      return null;
  }
}

export function registerNativeAsset(db: ServiceDatabase, assetRoot: string, body: unknown) {
  if (!isRecord(body)) throw new NativeAssetError(400, "Invalid native asset body");
  if (typeof body.channelId !== "string" || !body.channelId.trim()) throw new NativeAssetError(400, "Invalid channelId");
  const channelId = body.channelId;
  if (!CANONICAL_EMOTIONS.some((emotion) => emotion === body.emotion)) throw new NativeAssetError(400, "Invalid emotion");
  const emotion = String(body.emotion);
  if (body.prompt !== undefined && typeof body.prompt !== "string") throw new NativeAssetError(400, "Invalid prompt");
  const visualAffect = parseVisualAffectV2(body.visualAffect);
  if (!visualAffect) throw new NativeAssetError(400, "Invalid visualAffect");
  if (typeof body.dataBase64 !== "string" || !body.dataBase64
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.dataBase64)) {
    throw new NativeAssetError(400, "Invalid dataBase64");
  }
  const bytes = Buffer.from(body.dataBase64, "base64");
  const extension = imageExtension(body.contentType, bytes);
  if (!extension || !bytes.length || bytes.toString("base64") !== body.dataBase64) throw new NativeAssetError(400, "Invalid image bytes or contentType");
  const contentType = String(body.contentType);
  const contentHash = sha256Bytes(bytes);
  const id = `native_${contentHash.slice(0, 12)}`;

  // An immediate transaction serializes the existence checks and immutable writes.
  return db.db.transaction(() => {
    const assetSetId = new ServiceDatabaseSemanticAssetRepository(db).assetSetIdForChannel(channelId);
    if (!assetSetId || !db.db.prepare("SELECT 1 FROM asset_sets WHERE id = ?").get(assetSetId)) {
      throw new NativeAssetError(404, "Channel has no mapped asset set");
    }
    if (assetSetId === "." || assetSetId === ".." || /[/\\\0]/.test(assetSetId)) throw new NativeAssetError(400, "Invalid mapped asset set id");
    const existing = db.db.prepare(`SELECT a.id, a.asset_set_id AS assetSetId, a.emotion, a.filename,
        a.content_hash AS contentHash, o.object_url AS url
      FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id WHERE a.id = ?`)
      .get(id) as { id: string; assetSetId: string; emotion: string; filename: string; contentHash: string; url: string } | undefined;
    if (existing) {
      if (existing.contentHash !== contentHash || existing.assetSetId !== assetSetId) throw new NativeAssetError(409, "Native asset id already belongs to another asset");
      return { status: 200, body: { asset: { id, assetSetId, emotion: existing.emotion, filename: existing.filename }, media: { url: existing.url } } };
    }
    const filename = `${contentHash.slice(0, 12)}.${extension}`;
    const storageKey = `native/${assetSetId}/${emotion}/${filename}`;
    if (db.db.prepare("SELECT 1 FROM storage_objects WHERE storage_key = ?").get(storageKey)) throw new NativeAssetError(409, "Native storage object already exists");
    const localPath = join(assetRoot, storageKey);
    mkdirSync(dirname(localPath), { recursive: true });
    try {
      writeFileSync(localPath, bytes, { flag: "wx" });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new NativeAssetError(409, "Native image file already exists");
      throw error;
    }
    try {
      const metadata = { source: "hent-brain-native", ...(body.prompt !== undefined ? { prompt: body.prompt } : {}) };
      const storageObjectId = db.upsertStorageObject({
        storageKey, objectUrl: staticObjectUrl(storageKey), contentHash, contentType,
        sizeBytes: bytes.length, provenance: "native", localPath, metadata,
      });
      db.upsertAsset({
        id, assetSetId, emotion, filename, storageObjectId, contentHash, metadata,
        semanticTags: visualAffect, semanticVector: affectVectorFromDimensions(visualAffect.dimensions),
      });
    } catch (error) {
      unlinkSync(localPath);
      throw error;
    }
    // This insertion changes candidate count, invalidating todo 1's set/count/max-updated cache key.
    return { status: 201, body: { asset: { id, assetSetId, emotion, filename }, media: { url: staticObjectUrl(storageKey) } } };
  }).immediate();
}
