import { createHash } from "node:crypto";
import { CANONICAL_EMOTIONS, type Emotion } from "../../shared/emotions.js";
import { parseResponseAffectV2, type ResponseAffectV2 } from "../../shared/affect.js";
import type { ServiceDatabase } from "./db.js";
import type { SemanticAssetMedia, SemanticAssetRouter } from "./semantic-assets/ports.js";
import type { FinalResponseVerifier, VerifierJudgment } from "./verifier.js";

export const FINAL_VERDICT_SCHEMA_VERSION = "FinalEmotionVerdictV1";
export const SERVICE_MEDIA_RESPONSE_SCHEMA_VERSION = "ServiceMediaResponseV1";
export const VERIFIER_CACHE_POLICY_VERSION = "VerifierCachePolicyV4-NormalizedAffect";
export const ASSET_POLICY_VERSION = "ServiceAssetPolicyV2-AffectSpaceV2";

const VERIFIER_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const CANONICAL_EMOTION_SET = new Set<string>(CANONICAL_EMOTIONS);

export type ServiceMedia = {
  filename: string;
  contentType: string;
  url: string;
  sensitiveMedia: true;
  metadata: { storageKey: string };
};

export type ServiceMediaResponse = {
  media: ServiceMedia | null;
  diagnostics?: Array<{ skipped: true; reason: string }>;
};

export type FinalVerdict = {
  emotion?: string;
  confidence?: number;
  reason?: string;
  affect?: ResponseAffectV2;
  media?: ServiceMedia;
};

export type FinalVerdictResult = {
  verdict: FinalVerdict | null;
  diagnostics?: Array<{ skipped: true; reason: string }>;
};

export type FinalResponseRequest = {
  readonly channelId?: string;
  readonly finalText?: string;
  readonly validEmotions?: readonly string[];
  readonly responseAffect?: ResponseAffectV2;
};

export interface FinalResponseUseCase {
  execute(request: FinalResponseRequest): Promise<FinalVerdictResult>;
}

export function createFinalResponseUseCase(dependencies: {
  readonly db: ServiceDatabase;
  readonly verifier: FinalResponseVerifier;
  readonly assetRouter: SemanticAssetRouter;
}): FinalResponseUseCase {
  return {
    async execute(request) {
      const explicitValidEmotions = normalizeEmotions(request.validEmotions ?? []);
      const validEmotions = (request.validEmotions?.length ?? 0) > 0
        ? explicitValidEmotions
        : validEmotionsForChannel(dependencies.db, request.channelId);
      if (!request.finalText || validEmotions.length === 0) {
        return skippedVerdict("no_final_text_or_valid_emotions");
      }

      const responseAffect = parseResponseAffectV2(request.responseAffect);
      const key = verdictCacheKey(request.channelId, request.finalText, validEmotions, responseAffect ?? undefined);
      const cached = cachedVerdict(dependencies.db, key, validEmotions);
      if (cached !== undefined) {
        if (!cached) return skippedVerdict("cached_null_verdict");
        return verdictWithRoutedMedia(dependencies.assetRouter, request.channelId, request.finalText, cached);
      }

      let selected: VerifierJudgment | null = responseAffect ? { affect: responseAffect } : null;
      if (!selected) {
        try {
          selected = await dependencies.verifier.verify({
            channelId: request.channelId,
            finalText: request.finalText,
            validEmotions,
          });
        } catch (error) {
          console.warn(`[hent-ai-service] verifier error channelId=${request.channelId ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`);
          return skippedVerdict("verifier_error");
        }
      }

      const emotion = normalizeEmotion(selected?.emotion);
      const affect = parseResponseAffectV2(selected?.affect);
      if (!selected || (!affect && (!emotion || !validEmotions.includes(emotion)))) {
        storeCachedVerdict(dependencies.db, key, null);
        return skippedVerdict("verifier_emotion_invalid");
      }

      // Routing is downstream of verification. V2 uses the shared affect vector;
      // a valid coarse emotion remains optional compatibility data for legacy sets.
      const result = verdictWithRoutedMedia(dependencies.assetRouter, request.channelId, request.finalText, {
        ...selected,
        ...(emotion && validEmotions.includes(emotion) ? { emotion } : {}),
        ...(affect ? { affect } : {}),
      });
      if (!result.verdict) {
        storeCachedVerdict(dependencies.db, key, null);
        return result;
      }
      storeCachedVerdict(dependencies.db, key, result.verdict);
      return result;
    },
  };
}

function verdictWithRoutedMedia(
  assetRouter: SemanticAssetRouter,
  channelId: string | undefined,
  finalText: string,
  verdict: FinalVerdict,
): FinalVerdictResult {
  const emotion = normalizeEmotion(verdict.emotion);
  const affect = parseResponseAffectV2(verdict.affect);
  if (!channelId || (!emotion && !affect)) return skippedVerdict("no_asset_for_emotion");
  const selection = assetRouter.route({ channelId, ...(emotion ? { emotion } : {}), text: finalText, ...(affect ? { affect } : {}) });
  if (!selection) return skippedVerdict("no_asset_for_emotion");
  return { verdict: { ...verdict, ...(emotion ? { emotion } : {}), media: serviceMediaFrom(selection.media) } };
}

function serviceMediaFrom(media: SemanticAssetMedia): ServiceMedia {
  return {
    filename: media.filename,
    contentType: media.contentType,
    url: media.objectUrl,
    sensitiveMedia: true,
    metadata: { storageKey: media.storageKey },
  };
}

function normalizeEmotion(value: unknown): Emotion | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return CANONICAL_EMOTION_SET.has(normalized) ? normalized as Emotion : undefined;
}

function normalizeEmotions(values: readonly string[]): Emotion[] {
  const normalized = values.flatMap((value) => {
    const emotion = normalizeEmotion(value);
    return emotion ? [emotion] : [];
  });
  return [...new Set(normalized)];
}

function validEmotionsForChannel(db: ServiceDatabase, channelId: string | undefined): Emotion[] {
  if (!channelId) return [];
  const mapping = db.getChannelMapping(channelId);
  if (!mapping || mapping.enabled === false || !mapping.assetSetId) return [];
  const values = db.db.prepare("SELECT DISTINCT lower(emotion) AS emotion FROM assets WHERE asset_set_id = ? ORDER BY emotion")
    .all(mapping.assetSetId)
    .map((row) => String((row as { emotion: string }).emotion));
  return normalizeEmotions(values);
}

function verdictCacheKey(channelId: string | undefined, finalText: string, validEmotions: readonly Emotion[], responseAffect?: ResponseAffectV2): string {
  return createHash("sha256").update(JSON.stringify({
    version: FINAL_VERDICT_SCHEMA_VERSION,
    mediaVersion: SERVICE_MEDIA_RESPONSE_SCHEMA_VERSION,
    verifierCacheVersion: VERIFIER_CACHE_POLICY_VERSION,
    assetPolicyVersion: ASSET_POLICY_VERSION,
    channelId: channelId ?? null,
    finalText,
    validEmotions,
    responseAffect: responseAffect ?? null,
  })).digest("hex");
}

function cachedVerdict(db: ServiceDatabase, key: string, validEmotions: readonly Emotion[]): FinalVerdict | null | undefined {
  const row = db.db.prepare("SELECT verdict_json FROM verifier_cache WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)")
    .get(key, new Date().toISOString()) as { verdict_json: string } | undefined;
  if (!row) return undefined;
  const verdict = JSON.parse(row.verdict_json) as FinalVerdict | null;
  const emotion = normalizeEmotion(verdict?.emotion);
  const affect = parseResponseAffectV2(verdict?.affect);
  if (verdict && !affect && (!emotion || !validEmotions.includes(emotion))) return null;
  return verdict ? { ...verdict, ...(emotion && validEmotions.includes(emotion) ? { emotion } : {}) } : null;
}

function storeCachedVerdict(db: ServiceDatabase, key: string, verdict: FinalVerdict | null): void {
  const stamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + VERIFIER_CACHE_TTL_MS).toISOString();
  db.db.prepare(`INSERT INTO verifier_cache (cache_key, verdict_json, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET verdict_json = excluded.verdict_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(verdict), expiresAt, stamp, stamp);
}

function skippedVerdict(reason: string): FinalVerdictResult {
  return { verdict: null, diagnostics: [{ skipped: true, reason }] };
}
