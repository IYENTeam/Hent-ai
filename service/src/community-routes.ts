import type { ServiceDatabase } from "./db.js";

type CommunityConversationMessage = {
  authorId?: string;
  content: string;
  createdAt?: string;
};

export type CommunityGenerateRequest = {
  communitySelector?: {
    conversationWindow: CommunityConversationMessage[];
    draftReply: string;
    channelId: string;
    profileId: string;
    assetSetId: string;
  };
};

export type CronEnabledChannelResponse = {
  channelId: string;
  profileId: string | null;
  assetSetId: string | null;
  updatedAt: string | null;
};

export function validateCommunityGenerateRequest(body: unknown): CommunityGenerateRequest {
  const record = readBodyRecord(body);
  const selector = readBodyRecord(record.communitySelector);
  if (!record.communitySelector && !selector.channelId && !selector.draftReply) return record as CommunityGenerateRequest;

  const channelId = stringField(selector.channelId);
  const draftReply = stringField(selector.draftReply);
  const profileId = stringField(selector.profileId);
  const assetSetId = stringField(selector.assetSetId);
  if (!channelId) throw new Error("communitySelector.channelId is required");
  if (!draftReply) throw new Error("communitySelector.draftReply is required");
  if (!profileId) throw new Error("communitySelector.profileId is required");
  if (!assetSetId) throw new Error("communitySelector.assetSetId is required");
  return {
    ...record,
    communitySelector: {
      conversationWindow: parseConversationWindow(selector.conversationWindow),
      draftReply,
      channelId,
      profileId,
      assetSetId,
    },
  };
}

export function serializeJob(job: NonNullable<ReturnType<ServiceDatabase["getGenerationJob"]>>): unknown {
  return {
    jobId: job.id,
    id: job.id,
    status: job.status,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function parseConversationWindow(value: unknown): CommunityConversationMessage[] {
  if (!Array.isArray(value)) throw new Error("communitySelector.conversationWindow must be an array");
  return value.map((item) => {
    const record = readBodyRecord(item);
    const content = stringField(record.content);
    if (!content) throw new Error("communitySelector.conversationWindow[*].content is required");
    return {
      authorId: stringField(record.authorId),
      content,
      createdAt: stringField(record.createdAt),
    };
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}
