import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ServiceDatabase } from "../../service/src/db.js";
import { DEFAULT_CONVERSATION_CONFIG } from "../../service/src/conversation-config.js";
import { listen, createHentAiServer } from "../../service/src/server.js";
import {
  AFFECT_DIMENSIONS,
  AFFECT_SPACE_VERSION,
  RESPONSE_AFFECT_SCHEMA_VERSION,
  VISUAL_AFFECT_SCHEMA_VERSION,
  affectVectorFromDimensions,
  type AffectDimensionsV2,
} from "../../shared/affect.js";
import { sha256Bytes, staticObjectUrl } from "../../service/src/storage.js";

export const E2E_CHANNEL_ID = "e2e-room";
export const E2E_ASSET_SET_ID = "e2e-affect";
export const E2E_TOKEN = `hent-e2e-${randomUUID()}`;
export const PRE_REPLY_STORAGE_KEY = "sets/e2e-affect/neutral-pre.png";
export const FINAL_STORAGE_KEY = "sets/e2e-affect/happy-final.png";

const checkoutRoot = resolve(import.meta.dirname, "../..");

export type HentE2eRuntime = {
  readonly assetRoot: string;
  readonly baseUrl: string;
  readonly db: ServiceDatabase;
  readonly dbPath: string;
  readonly finalBytes: Buffer;
  readonly preReplyBytes: Buffer;
  readonly token: string;
  readonly verifierCalls: () => number;
  readonly stop: () => Promise<void>;
};

export async function startHentE2eRuntime(options: { token?: string; port?: number } = {}): Promise<HentE2eRuntime> {
  const root = await mkdtemp(join(tmpdir(), "hent-openclaw-e2e-"));
  const assetRoot = join(root, "assets");
  const dbPath = join(root, "service.sqlite");
  const preReplyPath = join(assetRoot, PRE_REPLY_STORAGE_KEY);
  const finalPath = join(assetRoot, FINAL_STORAGE_KEY);
  await mkdir(join(assetRoot, "sets", E2E_ASSET_SET_ID), { recursive: true });
  await Promise.all([
    copyFile(join(checkoutRoot, "assets/sets/gothic-v1/neutral.png"), preReplyPath),
    copyFile(join(checkoutRoot, "assets/sets/gothic-v1/happy.png"), finalPath),
  ]);
  const [preReplyBytes, finalBytes] = await Promise.all([readFile(preReplyPath), readFile(finalPath)]);

  const db = new ServiceDatabase(dbPath);
  db.createProfile({ id: E2E_ASSET_SET_ID, name: "E2E affect character" });
  db.upsertAssetSet({ id: E2E_ASSET_SET_ID, name: "E2E affect assets", character: "isolated" });
  const dimensions = (overrides: Partial<AffectDimensionsV2>) => Object.fromEntries(
    AFFECT_DIMENSIONS.map((key) => [key, overrides[key] ?? 0.1]),
  ) as AffectDimensionsV2;
  const neutralDimensions = dimensions({ valence: 0.5, arousal: 0.2, warmth: 0.35 });
  const happyDimensions = dimensions({ valence: 0.92, arousal: 0.72, joy: 0.95, warmth: 0.8, playfulness: 0.68, smileIntensity: 0.94, bodyOpenness: 0.75 });
  const visualTags = (values: AffectDimensionsV2, evidence: string) => ({
    schemaVersion: VISUAL_AFFECT_SCHEMA_VERSION,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    dimensions: values,
    confidence: 0.95,
    evidence: [evidence],
  });
  const preObjectId = db.upsertStorageObject({
    storageKey: PRE_REPLY_STORAGE_KEY,
    objectUrl: staticObjectUrl(PRE_REPLY_STORAGE_KEY),
    contentHash: sha256Bytes(preReplyBytes),
    contentType: "image/png",
    sizeBytes: preReplyBytes.byteLength,
    provenance: "e2e-fixture",
    localPath: preReplyPath,
  });
  db.upsertAsset({
    id: `${E2E_ASSET_SET_ID}:neutral:neutral-pre.png`,
    assetSetId: E2E_ASSET_SET_ID,
    emotion: "neutral",
    filename: "neutral-pre.png",
    storageObjectId: preObjectId,
    contentHash: sha256Bytes(preReplyBytes),
    semanticTags: visualTags(neutralDimensions, "calm neutral fixture"),
    semanticVector: affectVectorFromDimensions(neutralDimensions),
  });
  const finalObjectId = db.upsertStorageObject({
    storageKey: FINAL_STORAGE_KEY,
    objectUrl: staticObjectUrl(FINAL_STORAGE_KEY),
    contentHash: sha256Bytes(finalBytes),
    contentType: "image/png",
    sizeBytes: finalBytes.byteLength,
    provenance: "e2e-fixture",
    localPath: finalPath,
  });
  db.upsertAsset({
    id: `${E2E_ASSET_SET_ID}:happy:happy-final.png`,
    assetSetId: E2E_ASSET_SET_ID,
    emotion: "happy",
    filename: "happy-final.png",
    storageObjectId: finalObjectId,
    contentHash: sha256Bytes(finalBytes),
    semanticTags: visualTags(happyDimensions, "bright happy fixture"),
    semanticVector: affectVectorFromDimensions(happyDimensions),
  });
  db.setChannelMapping(E2E_CHANNEL_ID, {
    profileId: E2E_ASSET_SET_ID,
    assetSetId: E2E_ASSET_SET_ID,
    mode: "normal",
    enabled: true,
    cronEnabled: false,
  });

  let verifierCallCount = 0;
  const server = createHentAiServer({
    db,
    token: options.token ?? E2E_TOKEN,
    assetRoot,
    verifier: {
      async verify() {
        verifierCallCount += 1;
        return {
          emotion: "happy",
          confidence: 0.99,
          reason: "deterministic affect e2e verifier",
          affect: {
            schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
            affectSpaceVersion: AFFECT_SPACE_VERSION,
            dimensions: happyDimensions,
            confidence: 0.99,
          },
        };
      },
    },
    conversationConfig: {
      ...DEFAULT_CONVERSATION_CONFIG,
      enabled: true,
      minDelayMs: 0,
      maxDelayMs: 0,
      maxChunks: 4,
      maxChunkChars: 32,
      cooldownMs: 60_000,
      budgetPerHour: 20,
      minHumanIdleMs: 0,
      confidenceThreshold: 0.5,
      diagnostics: [],
    },
  });
  let binding: Awaited<ReturnType<typeof listen>>;
  try {
    binding = await listen(server, options.port ?? 0, "127.0.0.1");
  } catch (error) {
    db.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  return {
    assetRoot,
    baseUrl: binding.url,
    db,
    dbPath,
    finalBytes,
    preReplyBytes,
    token: options.token ?? E2E_TOKEN,
    verifierCalls: () => verifierCallCount,
    async stop() {
      if (stopped) return;
      stopped = true;
      await binding.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
