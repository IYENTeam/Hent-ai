import type { Emotion } from "../../../shared/emotions.js";
import type { ServiceDatabase } from "../db.js";
import type { SemanticAssetCandidate, SemanticAssetRepository } from "./ports.js";

export class ServiceDatabaseSemanticAssetRepository implements SemanticAssetRepository {
  constructor(private readonly database: ServiceDatabase) {}

  assetSetIdForChannel(channelId: string): string | null {
    const mapping = this.database.getChannelMapping(channelId);
    if (!mapping || mapping.enabled === false) return null;
    return mapping.assetSetId;
  }

  listCandidates(assetSetId: string, emotion?: Emotion): readonly SemanticAssetCandidate[] {
    return emotion
      ? this.database.listAssetsForSetEmotion(assetSetId, emotion)
      : this.database.listAssetsForSet(assetSetId);
  }
}
