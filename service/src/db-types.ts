export type Profile = {
  id: string;
  name: string;
  character: string | null;
  soulSnippet: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProfileCreateInput = {
  id: string;
  name: string;
  character?: string | null;
  soulSnippet?: string | null;
  model?: string | null;
};

export type ProfileUpdateInput = Partial<Omit<ProfileCreateInput, "id">>;

export type ChannelMapping = {
  channelId: string;
  profileId: string | null;
  mode: string | null;
  enabled: boolean | null;
  cronEnabled: boolean | null;
  assetSetId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type StorageObjectInput = {
  storageKey: string;
  objectUrl: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
  provenance: string;
  localPath?: string | null;
  metadata?: unknown;
};

export type AssetUpsertInput = {
  id: string;
  assetSetId: string;
  emotion: string;
  filename: string;
  storageObjectId: number;
  contentHash: string;
  metadata?: unknown;
  semanticTags?: unknown;
  semanticVector?: readonly number[] | null;
};

export type StoredSemanticAssetCandidate = {
  id: string;
  assetSetId: string;
  emotion: string;
  filename: string;
  contentType: string;
  objectUrl: string;
  storageKey: string;
  semanticTags: unknown;
  semanticVector: unknown;
};

export type GenerationJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  request: unknown;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
