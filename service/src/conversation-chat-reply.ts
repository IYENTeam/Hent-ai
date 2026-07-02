import type { ConversationDecisionProvider, ConversationServiceConfig, ConversationTurn } from "./conversation-config.js";
import type { ConversationRawEvent, ConversationStore } from "./conversation-store.js";
import { evaluateConversationSpeechPolicy } from "./conversation-speech-policy.js";

export type ConversationChatReplyInput = {
  readonly scopeId: string;
  readonly channelId: string;
};

export type ConversationChatReplyResult =
  | {
    readonly decision: "speak";
    readonly chunks: readonly string[];
    readonly diagnostics?: readonly string[];
  }
  | {
    readonly decision: "no_reply";
    readonly reason: string;
    readonly diagnostics?: readonly string[];
  };

export type EvaluateConversationChatReplyInput = {
  readonly config: ConversationServiceConfig;
  readonly store: ConversationStore;
  readonly decisionProvider?: ConversationDecisionProvider;
  readonly scope: ConversationChatReplyInput;
  readonly maxRecentTurns: number;
  readonly nowMs: number;
};

export async function evaluateConversationChatReply(
  input: EvaluateConversationChatReplyInput,
): Promise<ConversationChatReplyResult> {
  if (!input.config.enabled) return { decision: "no_reply", reason: "service_disabled" };
  if (!input.decisionProvider) return { decision: "no_reply", reason: "missing_decision_provider" };

  const recentEvents = input.store.listRawEvents(input.scope.scopeId).slice(-input.maxRecentTurns);
  const recentTurns = recentEvents.flatMap((event) => eventToConversationTurn(event));
  const memorySummaries = input.store.listSummaries(input.scope.scopeId).map((summary) => summary.summary);
  const providerDecision = await input.decisionProvider.decide({
    config: input.config,
    scope: input.scope,
    recentTurns,
    memorySummaries,
  });
  if (providerDecision.kind === "no_reply") {
    return { decision: "no_reply", reason: providerDecision.reason, diagnostics: providerDecision.diagnostics?.map((diagnostic) => diagnostic.code) };
  }

  const policy = evaluateConversationSpeechPolicy({
    config: input.config,
    channel: { enabled: true },
    state: conversationPolicyState(recentTurns, input.nowMs),
    provider: { confidence: providerDecision.confidence },
    safeguards: {
      privacyAllowed: true,
      threadAllowed: true,
      duplicateTurn: false,
      selfEcho: false,
    },
    nowMs: input.nowMs,
  });
  if (!policy.allowed) return { decision: "no_reply", reason: policy.suppressedReason };

  return {
    decision: "speak",
    chunks: providerDecision.chunks,
    diagnostics: [`persona:${policy.persona.source}`, `budgetRemaining:${policy.budgetRemaining}`],
  };
}

function eventToConversationTurn(event: ConversationRawEvent): readonly ConversationTurn[] {
  const base = {
    scopeId: event.scopeId,
    channelId: event.channelId,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    content: event.text,
    observedAtMs: Date.parse(event.eventTs),
  };
  switch (event.authorRole) {
    case "assistant":
      return [{ ...base, author: "assistant" }];
    case "user":
      return [{ ...base, author: "user" }];
    case "system":
      return [];
    default:
      return assertNeverAuthorRole(event.authorRole);
  }
}

function conversationPolicyState(turns: readonly ConversationTurn[], nowMs: number): {
  readonly lastSpeechAtMs: number | null;
  readonly speechCountThisHour: number;
  readonly lastHumanMessageAtMs: number | null;
} {
  const hourStartMs = nowMs - 3_600_000;
  const assistantTurns = turns.filter((turn) => turn.author === "assistant");
  const humanTurns = turns.filter((turn) => turn.author === "user");
  return {
    lastSpeechAtMs: assistantTurns.at(-1)?.observedAtMs ?? null,
    speechCountThisHour: assistantTurns.filter((turn) => turn.observedAtMs >= hourStartMs).length,
    lastHumanMessageAtMs: humanTurns.at(-1)?.observedAtMs ?? null,
  };
}

function assertNeverAuthorRole(value: never): never {
  throw new Error(`Unhandled conversation author role: ${String(value)}`);
}
