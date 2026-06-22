import type { ConversationProviderDiagnostic, ConversationScope, ConversationTurn } from "./conversation-config.js";
import { buildMemoryCompactionPrompt, parseMemoryCompactionResponse, type ConversationPrompt } from "./conversation-contracts.js";
import type { ConversationRawEvent, ConversationStore } from "./conversation-store.js";

export type ConversationMemoryCompactionRequest = {
  readonly prompt: ConversationPrompt;
  readonly scope: ConversationScope;
  readonly sourceEvents: readonly ConversationRawEvent[];
};

export interface ConversationMemoryCompactionProvider {
  readonly compact: (request: ConversationMemoryCompactionRequest) => Promise<string | null>;
}

export type ConversationMemoryDiagnostic = ConversationProviderDiagnostic & {
  readonly scopeId: string;
  readonly retryable: boolean;
};

export type ConversationMemoryCompactionConfig = {
  readonly rawRetentionDays: number;
};

export type CompactConversationMemoryInput = {
  readonly store: ConversationStore;
  readonly provider: ConversationMemoryCompactionProvider;
  readonly config: ConversationMemoryCompactionConfig;
  readonly now: string;
};

export type CompactConversationMemoryResult = {
  readonly compactedScopeCount: number;
  readonly summaryCount: number;
  readonly prunedRawCount: number;
  readonly diagnostics: readonly ConversationMemoryDiagnostic[];
};

type ScopeGroup = {
  readonly scope: ConversationScope;
  readonly events: readonly ConversationRawEvent[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function compactConversationMemory(input: CompactConversationMemoryInput): Promise<CompactConversationMemoryResult> {
  const cutoff = new Date(new Date(input.now).getTime() - input.config.rawRetentionDays * MS_PER_DAY).toISOString();
  const groups = input.store.listRawEventScopeIdsBefore(cutoff).map((scopeId) => groupEventsForScope(input.store, scopeId, cutoff));
  const diagnostics: ConversationMemoryDiagnostic[] = [];
  let compactedScopeCount = 0;
  let summaryCount = 0;
  let prunedRawCount = 0;

  for (const group of groups) {
    if (group.events.length === 0) continue;
    const prompt = buildMemoryCompactionPrompt({
      scope: group.scope,
      olderTurns: group.events.map(eventToTurn),
    });
    const providerText = await requestProvider(input.provider, { prompt, scope: group.scope, sourceEvents: group.events });
    if (providerText.kind === "failed") {
      diagnostics.push(providerText.diagnostic);
      continue;
    }
    const parsed = parseMemoryCompactionResponse(providerText.text);
    if (parsed.kind === "no_reply") {
      diagnostics.push(toDiagnostic(group.scope.scopeId, parsed.diagnostics[0] ?? { code: parsed.reason, message: parsed.reason }));
      continue;
    }
    if (parsed.value.scopeId !== group.scope.scopeId) {
      diagnostics.push(toDiagnostic(group.scope.scopeId, { code: "scope_mismatch", message: "memory compaction scope did not match requested scope" }));
      continue;
    }
    const firstEvent = group.events[0];
    const lastEvent = group.events.at(-1);
    if (!firstEvent || !lastEvent) continue;
    input.store.addSummary({
      scopeId: group.scope.scopeId,
      channelId: group.scope.channelId,
      summary: parsed.value.summary,
      sourceEventStartId: firstEvent.id,
      sourceEventEndId: lastEvent.id,
      createdAt: input.now,
    });
    summaryCount += 1;
    compactedScopeCount += 1;
    prunedRawCount += input.store.deleteRawEventsByIds(group.events.map((event) => event.id));
  }

  return { compactedScopeCount, summaryCount, prunedRawCount, diagnostics };
}

async function requestProvider(
  provider: ConversationMemoryCompactionProvider,
  request: ConversationMemoryCompactionRequest,
): Promise<
  | { readonly kind: "ok"; readonly text: string | null }
  | { readonly kind: "failed"; readonly diagnostic: ConversationMemoryDiagnostic }
> {
  try {
    return { kind: "ok", text: await provider.compact(request) };
  } catch (error) {
    if (error instanceof Error) {
      return { kind: "failed", diagnostic: toDiagnostic(request.scope.scopeId, { code: "provider_error", message: error.message }) };
    }
    return { kind: "failed", diagnostic: toDiagnostic(request.scope.scopeId, { code: "provider_error", message: "provider failed with a non-error value" }) };
  }
}

function groupEventsForScope(store: ConversationStore, scopeId: string, cutoff: string): ScopeGroup {
  const events = store.listRawEvents(scopeId).filter((event) => event.eventTs < cutoff);
  return {
    scope: scopeFromEvent(events[0]),
    events,
  };
}

function scopeFromEvent(event: ConversationRawEvent | undefined): ConversationScope {
  if (!event) return { scopeId: "", channelId: "" };
  return {
    scopeId: event.scopeId,
    channelId: event.channelId,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
  };
}

function eventToTurn(event: ConversationRawEvent): ConversationTurn {
  return {
    ...scopeFromEvent(event),
    author: turnAuthorFromRaw(event),
    content: event.text,
    observedAtMs: new Date(event.observedAt).getTime(),
  };
}

function turnAuthorFromRaw(event: ConversationRawEvent): "user" | "assistant" {
  switch (event.authorRole) {
    case "user":
      return "user";
    case "assistant":
    case "system":
      return "assistant";
  }
}

function toDiagnostic(scopeId: string, diagnostic: ConversationProviderDiagnostic): ConversationMemoryDiagnostic {
  return { scopeId, code: diagnostic.code, message: diagnostic.message, retryable: true };
}
