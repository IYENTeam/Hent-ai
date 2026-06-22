import { createHash } from "node:crypto";
import type { ServiceDatabase } from "./db.js";
import type { FinalResponseVerifier, VerifierJudgment } from "./verifier.js";

export type ServiceMediaResponse = {
  media: {
    filename: string;
    contentType: string;
    url: string;
    sensitiveMedia: true;
    metadata: { storageKey: string };
  } | null;
  diagnostics?: Array<{ skipped: true; reason: string }>;
};

type FinalVerdict = {
  emotion: string;
  confidence?: number;
  reason?: string;
  media?: ServiceMediaResponse["media"];
};

type FinalVerdictResult = {
  verdict: FinalVerdict | null;
  diagnostics?: Array<{ skipped: true; reason: string }>;
};

export function mediaResponseForChannel(db: ServiceDatabase, channelId: string | undefined): ServiceMediaResponse {
  if (!channelId) return { media: null, diagnostics: [{ skipped: true, reason: "missing_channel_id" }] };
  const asset = db.firstAssetForChannel(channelId);
  if (!asset) return { media: null, diagnostics: [{ skipped: true, reason: "no_policy_result" }] };
  return {
    media: {
      filename: asset.filename,
      contentType: asset.contentType,
      url: asset.objectUrl,
      sensitiveMedia: true,
      metadata: { storageKey: asset.storageKey },
    },
  };
}

export async function finalVerdictForBody(db: ServiceDatabase, verifier: FinalResponseVerifier, body: unknown): Promise<FinalVerdictResult> {
  const channelId = channelIdFromHookBody(body);
  const finalText = finalResponseTextFromBody(body);
  const explicitValidEmotions = validEmotionsFromBody(body);
  const validEmotions = explicitValidEmotions.length ? explicitValidEmotions : validEmotionsForChannel(db, channelId);
  if (!finalText || validEmotions.length === 0) return skippedVerdict("no_final_text_or_valid_emotions");

  const key = verdictCacheKey(channelId, finalText, validEmotions);
  const cached = cachedVerdict(db, key, validEmotions);
  if (cached !== undefined) {
    if (!cached) return skippedVerdict("cached_null_verdict");
    const media = mediaResponseForChannelEmotion(db, channelId, cached.emotion);
    return media ? { verdict: { ...cached, media } } : skippedVerdict("no_asset_for_emotion");
  }

  let selected: VerifierJudgment | null;
  try {
    selected = await verifier.verify({ channelId, finalText, validEmotions });
  } catch (error) {
    console.warn(`[hent-ai-service] verifier error channelId=${channelId ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`);
    return skippedVerdict("verifier_error");
  }

  const emotion = typeof selected?.emotion === "string" ? selected.emotion.trim().toLowerCase() : undefined;
  if (!selected || !emotion || !validEmotions.includes(emotion)) {
    storeCachedVerdict(db, key, null);
    return skippedVerdict("verifier_emotion_invalid");
  }

  const media = mediaResponseForChannelEmotion(db, channelId, emotion);
  if (!media) {
    storeCachedVerdict(db, key, null);
    return skippedVerdict("no_asset_for_emotion");
  }

  const verdict: FinalVerdict = { ...selected, emotion, media };
  storeCachedVerdict(db, key, verdict);
  return { verdict };
}

export function channelIdFromHookBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { channelId?: unknown; context?: { channelId?: unknown } };
  const channelId = record.context?.channelId ?? record.channelId;
  return typeof channelId === "string" && channelId.trim() ? channelId.trim() : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function finalResponseTextFromBody(body: unknown): string | undefined {
  const record = readBodyRecord(body);
  const context = readBodyRecord(record.context);
  return stringField(record.finalText) ?? stringField(record.content) ?? stringField(record.text)
    ?? stringField(context.finalText) ?? stringField(context.content) ?? stringField(context.text);
}

function validEmotionsFromBody(body: unknown): string[] {
  const record = readBodyRecord(body);
  const context = readBodyRecord(record.context);
  const value = Array.isArray(record.validEmotions) ? record.validEmotions : context.validEmotions;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().toLowerCase()))];
}

function mediaResponseForChannelEmotion(db: ServiceDatabase, channelId: string | undefined, emotion: string): ServiceMediaResponse["media"] {
  if (!channelId) return null;
  const mapping = db.getChannelMapping(channelId);
  if (!mapping || mapping.enabled === false || !mapping.assetSetId) return null;
  const row = db.db.prepare(`SELECT a.filename, o.content_type, o.object_url, o.storage_key
    FROM assets a JOIN storage_objects o ON o.id = a.storage_object_id
    WHERE a.asset_set_id = ? AND lower(a.emotion) = ? ORDER BY a.filename LIMIT 1`).get(mapping.assetSetId, emotion.toLowerCase()) as Record<string, unknown> | undefined;
  return row ? {
    filename: String(row.filename),
    contentType: String(row.content_type),
    url: String(row.object_url),
    sensitiveMedia: true,
    metadata: { storageKey: String(row.storage_key) },
  } : null;
}

function validEmotionsForChannel(db: ServiceDatabase, channelId: string | undefined): string[] {
  if (!channelId) return [];
  const mapping = db.getChannelMapping(channelId);
  if (!mapping || mapping.enabled === false || !mapping.assetSetId) return [];
  return db.db.prepare("SELECT DISTINCT lower(emotion) AS emotion FROM assets WHERE asset_set_id = ? ORDER BY emotion")
    .all(mapping.assetSetId)
    .map((row) => String((row as { emotion: string }).emotion));
}

function verdictCacheKey(channelId: string | undefined, finalText: string, validEmotions: string[]): string {
  return createHash("sha256").update(JSON.stringify({ channelId: channelId ?? null, finalText, validEmotions })).digest("hex");
}

function cachedVerdict(db: ServiceDatabase, key: string, validEmotions: string[]): FinalVerdict | null | undefined {
  const row = db.db.prepare("SELECT verdict_json FROM verifier_cache WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)")
    .get(key, new Date().toISOString()) as { verdict_json: string } | undefined;
  if (!row) return undefined;
  const verdict = JSON.parse(row.verdict_json) as FinalVerdict | null;
  if (verdict && !validEmotions.includes(verdict.emotion)) return null;
  return verdict;
}

function storeCachedVerdict(db: ServiceDatabase, key: string, verdict: FinalVerdict | null): void {
  const stamp = new Date().toISOString();
  db.db.prepare(`INSERT INTO verifier_cache (cache_key, verdict_json, expires_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET verdict_json = excluded.verdict_json, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(verdict), stamp, stamp);
}

function skippedVerdict(reason: string): FinalVerdictResult {
  return { verdict: null, diagnostics: [{ skipped: true, reason }] };
}
