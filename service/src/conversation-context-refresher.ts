import type { ConversationProviderDiagnostic, ConversationScope, ConversationServiceConfig, ConversationTurn } from "./conversation-config.js";
import { buildShortTermContextPrompt, parseShortTermContextResponse, type ConversationShortTermContext } from "./conversation-contracts.js";
import type { ConversationProviderClient } from "./conversation-provider-client.js";
import type { ConversationRawEvent, ConversationStore } from "./conversation-store.js";

export type ConversationContextRefreshResult =
  | { readonly status: "fresh"; readonly diagnostics: readonly ConversationProviderDiagnostic[] }
  | { readonly status: "updated"; readonly diagnostics: readonly ConversationProviderDiagnostic[] }
  | { readonly status: "fallback"; readonly diagnostics: readonly ConversationProviderDiagnostic[] }
  | { readonly status: "disabled"; readonly diagnostics: readonly ConversationProviderDiagnostic[] };

export type RefreshConversationContextInput = {
  readonly store: ConversationStore;
  readonly client: ConversationProviderClient;
  readonly config: ConversationServiceConfig;
  readonly scope: ConversationScope;
  readonly model?: string;
  readonly now: string;
};

export async function refreshConversationContext(input: RefreshConversationContextInput): Promise<ConversationContextRefreshResult> {
  if (!input.config.contextRefreshEnabled) return { status: "disabled", diagnostics: [] };
  const recentEvents = input.store.listRawEvents(input.scope.scopeId).slice(-input.config.recentTurnWindow);
  const recentEventIds = recentEvents.map((event) => event.id);
  const checkpoint = input.store.getCheckpoint(input.scope.scopeId);
  if (sameNumberArray(checkpoint?.recentEventIds ?? [], recentEventIds)) {
    return { status: "fresh", diagnostics: [] };
  }
  const text = await input.client.complete(buildShortTermContextPrompt({
    scope: input.scope,
    recentTurns: recentEvents.map(eventToTurn),
  }), input.model ? { model: input.model } : undefined);
  const parsed = parseShortTermContextResponse(text);
  if (parsed.kind === "ok" && parsed.value.scopeId === input.scope.scopeId) {
    input.store.upsertCheckpoint({
      scopeId: input.scope.scopeId,
      channelId: input.scope.channelId,
      summary: renderContext(parsed.value),
      recentEventIds,
      updatedAt: input.now,
    });
    return { status: "updated", diagnostics: parsed.diagnostics };
  }
  input.store.upsertCheckpoint({
    scopeId: input.scope.scopeId,
    channelId: input.scope.channelId,
    summary: summarizeRecentEvents(recentEvents),
    recentEventIds,
    updatedAt: input.now,
  });
  if (parsed.kind === "no_reply") return { status: "fallback", diagnostics: parsed.diagnostics };
  return { status: "fallback", diagnostics: [{ code: "scope_mismatch", message: "short-term context scope did not match requested scope" }] };
}

function renderContext(context: ConversationShortTermContext): string {
  return [
    `Active topic: ${context.activeTopic}`,
    context.recentIntent ? `Recent intent: ${context.recentIntent}` : "",
    context.openQuestions.length > 0 ? `Open questions: ${context.openQuestions.join("; ")}` : "",
    context.shouldRemember.length > 0 ? `Should remember: ${context.shouldRemember.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

function summarizeRecentEvents(events: readonly ConversationRawEvent[]): string {
  const turns = events.map((event) => `${event.authorRole}: ${event.text}`).join(" | ");
  return `Recent room context: ${turns}`;
}

function eventToTurn(event: ConversationRawEvent): ConversationTurn {
  return {
    scopeId: event.scopeId,
    channelId: event.channelId,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    author: event.authorRole === "user" ? "user" : "assistant",
    content: event.text,
    observedAtMs: Date.parse(event.observedAt),
  };
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
