import type { Emotion } from "../../../shared/emotions.js";
import type { ResponseAffectV2 } from "../../../shared/affect.js";

export type SemanticAssetMedia = {
  readonly filename: string;
  readonly contentType: string;
  readonly objectUrl: string;
  readonly storageKey: string;
};

export type SemanticAssetCandidate = SemanticAssetMedia & {
  readonly id: string;
  readonly assetSetId: string;
  readonly emotion: string;
  readonly semanticTags: unknown;
  readonly semanticVector: unknown;
};

export interface SemanticAssetRepository {
  assetSetIdForChannel(channelId: string): string | null;
  listCandidates(assetSetId: string, emotion?: Emotion): readonly SemanticAssetCandidate[];
}

export type SemanticAssetRouteInput = {
  readonly channelId: string;
  readonly emotion?: Emotion;
  readonly text: string;
  readonly affect?: ResponseAffectV2;
};

export type SemanticAssetSelection = {
  readonly media: SemanticAssetMedia;
  readonly mode: "affect-v2" | "semantic" | "legacy-fallback";
  readonly score: number | null;
  readonly distance?: number | null;
};

export interface SemanticAssetRouter {
  route(input: SemanticAssetRouteInput): SemanticAssetSelection | null;
}
