import type {
  ConversationProviderDiagnostic,
  ConversationScope,
  ConversationServiceConfig,
  ConversationTurn,
} from "./conversation-config.js";
import { parseShortTermContextResponse, type ConversationShortTermContext } from "./conversation-contracts.js";
import type { ConversationRawEvent, ConversationStore } from "./conversation-store.js";

export type ConversationContextProviderRequest = {
  readonly config: ConversationServiceConfig;
  readonly scope: ConversationScope;
  readonly recentTurns: readonly ConversationTurn[];
  readonly memorySummaries: readonly string[];
};

export interface ConversationContextProvider {
  readonly buildContext: (request: ConversationContextProviderRequest) => Promise<string | null> | string | null;
}

export type ConversationRuntimeOptions = {
  readonly contextProvider?: ConversationContextProvider;
};

export type ConversationEvaluateDiagnostics = {
  readonly context: ConversationContextDiagnostics;
};

export type ConversationContextDiagnostics =
  | {
      readonly providerStatus: "ok";
      readonly activeTopic: string;
      readonly confidence: number;
      readonly recentTurnCount: number;
      readonly memorySummaries: readonly string[];
    }
  | {
      readonly providerStatus: "no_reply";
      readonly recentTurnCount: number;
      readonly memorySummaries: readonly string[];
      readonly diagnostics: readonly ConversationProviderDiagnostic[];
    };

export type ConversationContextProviderEvaluation =
  | { readonly kind: "ok"; readonly diagnostics: ConversationContextDiagnostics }
  | { readonly kind: "no_reply"; readonly diagnostics: ConversationContextDiagnostics };

type EvaluateConversationContextInput = {
  readonly config: ConversationServiceConfig;
  readonly provider: ConversationContextProvider;
  readonly store: ConversationStore;
  readonly scope: ConversationScope;
  readonly maxRecentTurns: number;
};

export async function evaluateConversationContextProvider(
  input: EvaluateConversationContextInput,
): Promise<ConversationContextProviderEvaluation> {
  const recentTurns = input.store.listRawEvents(input.scope.scopeId).slice(-input.maxRecentTurns).flatMap((event) => eventToTurn(event));
  const memorySummaries = input.store.listSummaries(input.scope.scopeId).map((summary) => summary.summary);
  const providerOutput = await readContextProvider(input.provider, {
    config: input.config,
    scope: input.scope,
    recentTurns,
    memorySummaries,
  });
  if (providerOutput.kind === "no_reply") {
    return { kind: "no_reply", diagnostics: providerFailureDiagnostics(providerOutput.diagnostics, recentTurns.length, memorySummaries) };
  }
  const parsed = parseShortTermContextResponse(providerOutput.text);
  if (parsed.kind === "no_reply") {
    return { kind: "no_reply", diagnostics: providerFailureDiagnostics(parsed.diagnostics, recentTurns.length, memorySummaries) };
  }
  const lowConfidence = contextLowConfidenceDiagnostic(parsed.value, input.config);
  if (lowConfidence) {
    return { kind: "no_reply", diagnostics: providerFailureDiagnostics([lowConfidence], recentTurns.length, memorySummaries) };
  }
  return { kind: "ok", diagnostics: providerSuccessDiagnostics(parsed.value, recentTurns.length, memorySummaries) };
}

async function readContextProvider(
  provider: ConversationContextProvider,
  request: ConversationContextProviderRequest,
): Promise<{ readonly kind: "ok"; readonly text: string | null } | { readonly kind: "no_reply"; readonly diagnostics: readonly ConversationProviderDiagnostic[] }> {
  try {
    return { kind: "ok", text: await provider.buildContext(request) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider threw a non-error value";
    return { kind: "no_reply", diagnostics: [{ code: "provider_error", message }] };
  }
}

function providerSuccessDiagnostics(
  context: ConversationShortTermContext,
  recentTurnCount: number,
  memorySummaries: readonly string[],
): ConversationContextDiagnostics {
  return {
    providerStatus: "ok",
    activeTopic: context.activeTopic,
    confidence: context.confidence,
    recentTurnCount,
    memorySummaries,
  };
}

function providerFailureDiagnostics(
  diagnostics: readonly ConversationProviderDiagnostic[],
  recentTurnCount: number,
  memorySummaries: readonly string[],
): ConversationContextDiagnostics {
  return {
    providerStatus: "no_reply",
    recentTurnCount,
    memorySummaries,
    diagnostics,
  };
}

function eventToTurn(event: ConversationRawEvent): readonly ConversationTurn[] {
  const scope = {
    scopeId: event.scopeId,
    channelId: event.channelId,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
  };
  switch (event.authorRole) {
    case "assistant":
      return [{ ...scope, author: "assistant", content: event.text, observedAtMs: Date.parse(event.eventTs) }];
    case "user":
      return [{ ...scope, author: "user", content: event.text, observedAtMs: Date.parse(event.eventTs) }];
    case "system":
      return [];
    default:
      return assertNever(event.authorRole);
  }
}

function contextLowConfidenceDiagnostic(
  context: ConversationShortTermContext,
  config: ConversationServiceConfig,
): ConversationProviderDiagnostic | null {
  return context.confidence < config.confidenceThreshold
    ? { code: "low_confidence", message: `context confidence ${context.confidence} is below threshold ${config.confidenceThreshold}` }
    : null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled conversation author role: ${String(value)}`);
}
