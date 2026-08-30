import type { ConversationScope } from "./conversation-config.js";
import type { ConversationAuthorRole } from "./conversation-store.js";
import type { SenderRole } from "./watcher-core.js";

const WATCHER_DEFAULT_COOLDOWN_MS = 600_000;

type EvaluateScopeInput = {
  readonly scopeId: string;
  readonly channelId: string;
  readonly sourceThreadId?: string;
  readonly sessionId?: string;
};

export function validCooldownMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : WATCHER_DEFAULT_COOLDOWN_MS;
}

export function channelIdForScope(scopeId: string, explicitChannelId?: string): string {
  if (explicitChannelId) return explicitChannelId;
  const match = /^channel:([^:]+)/.exec(scopeId);
  return match?.[1] ?? scopeId;
}

export function legacyDeliveryPlanId(scopeId: string, signalId: string): string {
  return `watcher:${scopeId}:${signalId}`;
}

export function scopeForEvaluateInput(input: EvaluateScopeInput): ConversationScope {
  return {
    scopeId: input.scopeId,
    channelId: input.channelId,
    ...(input.sourceThreadId ? { threadId: input.sourceThreadId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

export function senderRoleForAuthor(authorRole: ConversationAuthorRole): SenderRole {
  switch (authorRole) {
    case "assistant":
      return "agent";
    case "system":
      return "system";
    case "user":
      return "user";
    default:
      return assertNever(authorRole);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled conversation author role: ${String(value)}`);
}
