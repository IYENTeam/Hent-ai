import type { ConversationServiceConfig } from "./conversation-config.js";
import { buildConversationDeliveryPlan, type ConversationDeliveryPlanResponse } from "./conversation-delivery-plan.js";
import type { ConversationStore } from "./conversation-store.js";

export const LEGACY_DELIVERY_CHUNK_ID = "legacy-delivery-message";

export type RuntimeDeliveryPlanInput = {
  readonly store: ConversationStore;
  readonly config: ConversationServiceConfig;
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly signalId: string;
  readonly cooldownKey: string;
  readonly createdAt: string;
  readonly text: string;
};

export type DeliveryCommitFields = {
  readonly planId: string;
  readonly cooldownKey: string;
  readonly scopeId: string;
  readonly signalId: string;
  readonly deliveryMessageIds: Readonly<Record<string, string>>;
};

export type RuntimeCommitDeliveryPlanInput = DeliveryCommitFields & {
  readonly store: ConversationStore;
  readonly config: ConversationServiceConfig;
  readonly now: Date;
};

export type RuntimeCommitDeliveryResult =
  | { readonly status: "committed" | "idempotent" }
  | { readonly status: "missing_required_chunks"; readonly missingChunkIds: readonly string[] }
  | { readonly status: "conflict" }
  | { readonly status: "not_found" };

export function createRuntimeDeliveryPlan(input: RuntimeDeliveryPlanInput): ConversationDeliveryPlanResponse {
  const deliveryPlan = buildConversationDeliveryPlan({
    planId: input.planId,
    scopeId: input.scopeId,
    channelId: input.channelId,
    signalId: input.signalId,
    cooldownKey: input.cooldownKey,
    text: input.text,
    config: input.config,
  });
  ensureDeliveryPlan({
    store: input.store,
    planId: input.planId,
    scopeId: input.scopeId,
    channelId: input.channelId,
    signalId: input.signalId,
    cooldownKey: input.cooldownKey,
    requiredChunkIds: deliveryPlan.commit.requiredChunkIds,
    createdAt: input.createdAt,
  });
  return deliveryPlan;
}

export function ensureLegacyDeliveryPlan(input: {
  readonly store: ConversationStore;
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly signalId: string;
  readonly cooldownKey: string;
  readonly createdAt: string;
}): void {
  ensureDeliveryPlan({ ...input, requiredChunkIds: [LEGACY_DELIVERY_CHUNK_ID] });
}

export function commitRuntimeDeliveryPlan(input: RuntimeCommitDeliveryPlanInput): RuntimeCommitDeliveryResult {
  const nowIso = input.now.toISOString();
  const plan = input.store.getDeliveryPlan(input.planId);
  if (!plan) return { status: "not_found" };
  if (plan.scopeId !== input.scopeId || plan.cooldownKey !== input.cooldownKey || plan.signalId !== input.signalId) {
    return { status: "conflict" };
  }
  const result = input.store.commitDelivery({
    planId: input.planId,
    deliveryMessageIds: input.deliveryMessageIds,
    committedAt: nowIso,
    cooldownUntil: new Date(input.now.getTime() + input.config.cooldownMs).toISOString(),
    budgetWindowStart: nowIso,
    budgetCount: 1,
  });
  switch (result.status) {
    case "committed":
    case "idempotent":
      return { status: result.status };
    case "missing_required_chunks":
      return { status: "missing_required_chunks", missingChunkIds: result.missingChunkIds };
    case "conflict":
      return { status: "conflict" };
    default:
      return assertNeverCommitResult(result);
  }
}

function ensureDeliveryPlan(input: {
  readonly store: ConversationStore;
  readonly planId: string;
  readonly scopeId: string;
  readonly channelId: string;
  readonly signalId: string;
  readonly cooldownKey: string;
  readonly requiredChunkIds: readonly string[];
  readonly createdAt: string;
}): void {
  if (input.store.getDeliveryPlan(input.planId)) return;
  input.store.createDeliveryPlan({
    planId: input.planId,
    scopeId: input.scopeId,
    channelId: input.channelId,
    signalId: input.signalId,
    cooldownKey: input.cooldownKey,
    requiredChunkIds: input.requiredChunkIds,
    createdAt: input.createdAt,
  });
}

function assertNeverCommitResult(value: never): never {
  throw new Error(`Unhandled commit delivery result: ${String(value)}`);
}
