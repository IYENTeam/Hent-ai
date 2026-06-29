import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServiceDatabase, GenerationJob } from "./db.js";
import { contentTypeForFilename, sha256Bytes, staticObjectUrl } from "./storage.js";

export type GenerationProvider = {
  generate(request: unknown): Promise<unknown>;
};

export type GenerationWorkerOptions = {
  assetRoot?: string;
  staleRunningAfterMs?: number;
};

type GeneratedImageResult = {
  dataBase64?: string;
  imageBase64?: string;
  contentType?: string;
  filename?: string;
  assetSetId?: string;
  emotion?: string;
  metadata?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "generated";
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "png";
}

function generatedImageFromResult(result: unknown): GeneratedImageResult | null {
  const record = asRecord(result);
  const dataBase64 = nonEmptyString(record.dataBase64) ?? nonEmptyString(record.imageBase64);
  if (!dataBase64) return null;
  return {
    dataBase64,
    imageBase64: nonEmptyString(record.imageBase64),
    contentType: nonEmptyString(record.contentType),
    filename: nonEmptyString(record.filename),
    assetSetId: nonEmptyString(record.assetSetId),
    emotion: nonEmptyString(record.emotion),
    metadata: record.metadata,
  };
}

function resultWithoutInlineImage(result: unknown): Record<string, unknown> {
  const record = { ...asRecord(result) };
  delete record.dataBase64;
  delete record.imageBase64;
  return record;
}

function hashUnknown(value: unknown): string {
  return sha256Bytes(JSON.stringify(value ?? null));
}

function assertGeneratedAssetWriteIsNew(db: ServiceDatabase, storageKey: string, assetId: string): void {
  const existingStorage = db.db.prepare("SELECT 1 FROM storage_objects WHERE storage_key = ?").get(storageKey);
  const existingAsset = db.db.prepare("SELECT 1 FROM assets WHERE id = ?").get(assetId);
  if (existingStorage || existingAsset) throw new Error("Generated assets are immutable and cannot overwrite existing objects");
}

function persistGeneratedImage(db: ServiceDatabase, job: GenerationJob, result: GeneratedImageResult, assetRoot: string): Record<string, unknown> {
  const request = asRecord(job.request);
  const assetSetId = safePathSegment(result.assetSetId ?? nonEmptyString(request.assetSetId) ?? nonEmptyString(request.profileId) ?? "generated");
  const emotion = safePathSegment(result.emotion ?? nonEmptyString(request.emotion) ?? "neutral");
  const requestedFilename = result.filename ?? nonEmptyString(request.filename);
  const contentType = result.contentType ?? (requestedFilename ? contentTypeForFilename(requestedFilename) : "image/png");
  const extension = extensionForContentType(contentType);
  const filename = safePathSegment(requestedFilename ?? `${emotion}.${extension}`);
  const storageKey = `generated/${assetSetId}/${emotion}/${job.id}-${filename}`;
  const localPath = join(assetRoot, storageKey);
  const bytes = Buffer.from(result.dataBase64 ?? "", "base64");
  if (bytes.length === 0) throw new Error("Generated image payload is empty");
  const assetId = `generated_${job.id}_${emotion}`;
  assertGeneratedAssetWriteIsNew(db, storageKey, assetId);

  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, bytes);

  db.upsertAssetSet({ id: assetSetId, name: assetSetId, manifest: { generated: true } });
  const contentHash = sha256Bytes(bytes);
  const provenanceMetadata = {
    jobId: job.id,
    requestHash: hashUnknown(job.request),
    providerMetadataHash: hashUnknown(result.metadata ?? null),
    contentHash,
    contentType,
    sizeBytes: bytes.length,
    dimensions: null,
    sourceReferences: [],
    source: "hent-ai-generation-worker",
    verificationStatus: "unverified",
  };
  const storageObjectId = db.upsertStorageObject({
    storageKey,
    objectUrl: staticObjectUrl(storageKey),
    contentHash,
    contentType,
    sizeBytes: bytes.length,
    provenance: "generated",
    localPath,
    metadata: provenanceMetadata,
  });
  db.upsertAsset({
    id: assetId,
    assetSetId,
    emotion,
    filename,
    storageObjectId,
    contentHash,
    metadata: {
      jobId: job.id,
      generated: true,
      contentHash,
      source: "hent-ai-generation-worker",
      verificationStatus: "unverified",
    },
  });

  return {
    asset: { id: assetId, assetSetId, emotion, filename },
    media: { url: staticObjectUrl(storageKey), contentType, storageKey, sizeBytes: bytes.length, contentHash },
  };
}

export async function runNextGenerationJob(db: ServiceDatabase, provider: GenerationProvider, options: GenerationWorkerOptions = {}): Promise<GenerationJob | null> {
  const staleRunningBefore = options.staleRunningAfterMs && options.staleRunningAfterMs > 0
    ? new Date(Date.now() - options.staleRunningAfterMs).toISOString()
    : undefined;
  const job = db.claimNextGenerationJob(staleRunningBefore);
  if (!job) return null;

  try {
    const result = await provider.generate(job.request);
    const generatedImage = generatedImageFromResult(result);
    if (generatedImage && options.assetRoot) {
      const persisted = persistGeneratedImage(db, job, generatedImage, options.assetRoot);
      return db.markGenerationJobSucceeded(job.id, { ...resultWithoutInlineImage(result), ...persisted });
    }
    return db.markGenerationJobSucceeded(job.id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return db.markGenerationJobFailed(job.id, message);
  }
}
