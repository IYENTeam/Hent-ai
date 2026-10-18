import {
  affectVectorFromDimensions,
  affectVectorMatchesDimensions,
  parseAffectVectorV2,
  parseVisualAffectV2,
  weightedAffectDistance,
} from "../../../shared/affect.js";
import { parseSemanticAssetTagsV1 } from "./contracts.js";
import type { SemanticAssetCandidate, SemanticAssetMedia, SemanticAssetRepository, SemanticAssetRouteInput, SemanticAssetRouter, SemanticAssetSelection } from "./ports.js";
import { cosineSimilarity, parseSemanticVector, semanticVectorForText } from "./vector.js";

function legacyOrder(left: SemanticAssetCandidate, right: SemanticAssetCandidate): number {
  return left.filename.localeCompare(right.filename) || left.id.localeCompare(right.id);
}

function mediaFrom(candidate: SemanticAssetCandidate): SemanticAssetMedia {
  return {
    filename: candidate.filename,
    contentType: candidate.contentType,
    objectUrl: candidate.objectUrl,
    storageKey: candidate.storageKey,
  };
}

export class DeterministicSemanticAssetRouter implements SemanticAssetRouter {
  private readonly thresholds = new Map<string, { readonly revision: string; readonly threshold: number }>();

  constructor(
    private readonly repository: SemanticAssetRepository,
    private readonly random: () => number = Math.random,
    private readonly nativeGenerateDistance = nativeGenerateDistanceFromEnv(),
  ) {}

  route(input: SemanticAssetRouteInput): SemanticAssetSelection | null {
    const assetSetId = this.repository.assetSetIdForChannel(input.channelId);
    if (!assetSetId) return null;

    const allCandidates = this.repository.listCandidates(assetSetId)
      .filter((candidate) => candidate.assetSetId === assetSetId)
      .sort(legacyOrder);
    const candidates = allCandidates
      .filter((candidate) => candidate.assetSetId === assetSetId && candidate.emotion.toLowerCase() === input.emotion)
      .sort(legacyOrder);
    const legacy = candidates[0] ?? allCandidates[0];
    if (!legacy) return null;

    if (input.affect) {
      const queryVector = affectVectorFromDimensions(input.affect.dimensions);
      const ranked = allCandidates.flatMap((candidate) => {
        const tags = parseVisualAffectV2(candidate.semanticTags);
        const vector = parseAffectVectorV2(candidate.semanticVector);
        if (!tags || !vector || !affectVectorMatchesDimensions(vector, tags.dimensions)) return [];
        return [{ candidate, vector, distance: weightedAffectDistance(queryVector, vector) }];
      });
      // V2 activates only for an entirely migrated set. A mixed set would make
      // nearest-neighbour selection depend on which rows happened to migrate.
      if (ranked.length === allCandidates.length && ranked.length > 0) {
        ranked.sort((left, right) => left.distance - right.distance || legacyOrder(left.candidate, right.candidate));
        const minimum = ranked[0]!.distance;
        const tied = ranked.filter((entry) => Math.abs(entry.distance - minimum) <= 1e-12);
        const randomValue = this.random();
        const index = Number.isFinite(randomValue)
          ? Math.min(tied.length - 1, Math.max(0, Math.floor(randomValue * tied.length)))
          : 0;
        const selected = tied[index]!;
        const threshold = this.nativeGenerateDistance ?? this.thresholdForSet(assetSetId, ranked);
        return {
          media: mediaFrom(selected.candidate),
          mode: "affect-v2",
          distance: selected.distance,
          score: 1 - selected.distance,
          threshold,
          generate: selected.distance > threshold,
          nearest: ranked.slice(0, 3).map((entry) => ({ media: mediaFrom(entry.candidate), distance: entry.distance })),
        };
      }
      return { media: mediaFrom(legacy), mode: "legacy-fallback", score: null, distance: null, threshold: null, generate: false, nearest: [] };
    }

    const queryVector = parseSemanticVector(semanticVectorForText(input.text));
    if (!queryVector) return { media: mediaFrom(legacy), mode: "legacy-fallback", score: null, threshold: null, generate: false, nearest: [] };

    const ranked = candidates.flatMap((candidate) => {
      const tags = parseSemanticAssetTagsV1(candidate.semanticTags);
      const vector = parseSemanticVector(candidate.semanticVector);
      if (!tags || tags.emotion !== input.emotion || !vector) return [];
      return [{ candidate, score: cosineSimilarity(queryVector, vector) }];
    });
    // A partially tagged set is not semantically active. This keeps legacy sets
    // deterministic and prevents incomplete imports from silently changing routing.
    if (ranked.length !== candidates.length) return { media: mediaFrom(legacy), mode: "legacy-fallback", score: null, threshold: null, generate: false, nearest: [] };

    ranked.sort((left, right) => right.score - left.score || legacyOrder(left.candidate, right.candidate));
    return { media: mediaFrom(ranked[0]!.candidate), mode: "semantic", score: ranked[0]!.score, threshold: null, generate: false, nearest: [] };
  }

  private thresholdForSet(assetSetId: string, candidates: readonly { readonly vector: readonly number[] }[]): number {
    const setRevision = this.repository.revisionForSet(assetSetId);
    const revision = JSON.stringify([candidates.length, setRevision]);
    const cached = this.thresholds.get(assetSetId);
    if (setRevision !== null && cached?.revision === revision) return cached.threshold;

    const distances = candidates.map((candidate, index) => {
      const others = candidates.filter((_, otherIndex) => otherIndex !== index);
      // A singleton has no leave-one-out neighbour: only an exact match fits.
      return others.length === 0 ? 0 : Math.min(...others.map((other) => weightedAffectDistance(candidate.vector, other.vector)));
    }).sort((left, right) => left - right);
    const threshold = distances[Math.ceil(0.95 * distances.length) - 1] ?? 0;
    // A repository that cannot name a revision must not have stale thresholds retained for it.
    if (setRevision !== null) this.thresholds.set(assetSetId, { revision, threshold });
    return threshold;
  }
}

function nativeGenerateDistanceFromEnv(): number | undefined {
  const raw = process.env.HENT_AI_NATIVE_GENERATE_DISTANCE?.trim();
  const distance = raw ? Number(raw) : NaN;
  // Blank, non-numeric and non-finite overrides are ignored.
  return Number.isFinite(distance) ? distance : undefined;
}
