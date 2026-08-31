import type { GenerationJob, Profile, StoredSemanticAssetCandidate } from "./db.js";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

function parseOptionalJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function rowToStoredSemanticAssetCandidate(row: Record<string, unknown>): StoredSemanticAssetCandidate {
  return {
    id: String(row.id),
    assetSetId: String(row.asset_set_id),
    emotion: String(row.emotion),
    filename: String(row.filename),
    contentType: String(row.content_type),
    objectUrl: String(row.object_url),
    storageKey: String(row.storage_key),
    semanticTags: parseOptionalJson(row.semantic_tags_json as string | null),
    semanticVector: parseOptionalJson(row.semantic_vector_json as string | null),
  };
}

export function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id),
    name: String(row.name),
    character: (row.character as string | null) ?? null,
    soulSnippet: (row.soul_snippet as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToJob(row: Record<string, unknown>): GenerationJob {
  return {
    id: String(row.id),
    status: row.status as GenerationJob["status"],
    request: parseJson(String(row.request_json), {}),
    result: parseJson(row.result_json as string | null, null),
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
