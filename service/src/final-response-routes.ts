import type { ServiceDatabase } from "./db.js";
import {
  ASSET_POLICY_VERSION,
  createFinalResponseUseCase,
  FINAL_VERDICT_SCHEMA_VERSION,
  SERVICE_MEDIA_RESPONSE_SCHEMA_VERSION,
  VERIFIER_CACHE_POLICY_VERSION,
  type FinalResponseRequest,
  type FinalVerdictResult,
  type ServiceMediaResponse,
} from "./final-response-use-case.js";
import { ServiceDatabaseSemanticAssetRepository } from "./semantic-assets/db-repository.js";
import type { SemanticAssetRouter } from "./semantic-assets/ports.js";
import { DeterministicSemanticAssetRouter } from "./semantic-assets/router.js";
import type { FinalResponseVerifier } from "./verifier.js";
import { parseResponseAffectV2, type ResponseAffectV2 } from "../../shared/affect.js";

export {
  ASSET_POLICY_VERSION,
  FINAL_VERDICT_SCHEMA_VERSION,
  SERVICE_MEDIA_RESPONSE_SCHEMA_VERSION,
  VERIFIER_CACHE_POLICY_VERSION,
};
export type { FinalVerdictResult, ServiceMediaResponse };

const MEDIA_DIRECTIVE_PATTERN = /[`"']?MEDIA:\s*(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"']+)[`"']?/gi;

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

export async function finalVerdictForBody(
  db: ServiceDatabase,
  verifier: FinalResponseVerifier,
  body: unknown,
  assetRouter: SemanticAssetRouter = new DeterministicSemanticAssetRouter(new ServiceDatabaseSemanticAssetRepository(db)),
): Promise<FinalVerdictResult> {
  return createFinalResponseUseCase({ db, verifier, assetRouter }).execute(finalResponseRequestFromBody(body));
}

export function finalResponseRequestFromBody(body: unknown): FinalResponseRequest {
  const responseAffect = responseAffectFromBody(body);
  return {
    channelId: channelIdFromHookBody(body),
    finalText: finalResponseTextFromBody(body),
    validEmotions: validEmotionsFromBody(body),
    ...(responseAffect ? { responseAffect } : {}),
  };
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
  const finalText = stringField(record.finalText) ?? stringField(record.content) ?? stringField(record.text)
    ?? stringField(context.finalText) ?? stringField(context.content) ?? stringField(context.text);
  return finalText ? sanitizeFinalResponseText(finalText) : undefined;
}

function sanitizeFinalResponseText(value: string): string | undefined {
  const sanitized = value
    .replace(MEDIA_DIRECTIVE_PATTERN, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\r?\n[ \t]*/g, "\n")
    .trim();
  return sanitized || undefined;
}

function validEmotionsFromBody(body: unknown): string[] {
  const record = readBodyRecord(body);
  const context = readBodyRecord(record.context);
  const value = Array.isArray(record.validEmotions) ? record.validEmotions : context.validEmotions;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().toLowerCase()))];
}

function responseAffectFromBody(body: unknown): ResponseAffectV2 | undefined {
  const record = readBodyRecord(body);
  const context = readBodyRecord(record.context);
  return parseResponseAffectV2(record.responseAffect ?? context.responseAffect) ?? undefined;
}
