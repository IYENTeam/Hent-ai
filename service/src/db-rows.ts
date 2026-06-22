import type { GenerationJob, Profile } from "./db.js";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
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
