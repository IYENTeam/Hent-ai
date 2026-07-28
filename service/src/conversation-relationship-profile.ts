import { createHash } from "node:crypto";

export type RelationshipProfile = {
  readonly rapport: number;
  readonly familiarity: number;
  readonly notes: readonly string[];
};

export type RelationshipUpdate = {
  readonly rapportDelta: number;
  readonly familiarityDelta: number;
  readonly notes: readonly string[];
};

const MAX_PROFILE_NOTES = 12;

export function mergeRelationshipProfile(current: RelationshipProfile | null, update: RelationshipUpdate): RelationshipProfile {
  const previous = current ?? { rapport: 0.5, familiarity: 0.5, notes: [] };
  return {
    rapport: clampUnit(previous.rapport + clampDelta(update.rapportDelta)),
    familiarity: clampUnit(previous.familiarity + clampDelta(update.familiarityDelta)),
    notes: stableNotes([...previous.notes, ...update.notes]),
  };
}

export function normalizeRelationshipNotes(notes: readonly string[]): readonly string[] {
  return stableNotes(notes, 3);
}

function stableNotes(notes: readonly string[], limit = MAX_PROFILE_NOTES): readonly string[] {
  const byHash = new Map<string, string>();
  for (const candidate of notes) {
    const note = candidate.trim().replace(/\s+/g, " ");
    if (note.length === 0 || note.length > 160) continue;
    const hash = createHash("sha256").update(note.toLocaleLowerCase("en-US")).digest("hex");
    const prior = byHash.get(hash);
    if (prior === undefined || note.localeCompare(prior) < 0) byHash.set(hash, note);
  }
  return [...byHash.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, limit)
    .map(([, note]) => note);
}

function clampDelta(value: number): number {
  return Number.isFinite(value) ? Math.max(-0.1, Math.min(0.1, value)) : 0;
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

