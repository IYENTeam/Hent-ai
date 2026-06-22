import type {
  ConversationAuthorRole,
  ConversationCheckpoint,
  ConversationGateState,
  ConversationRawEvent,
  ConversationSummary,
  DeliveryPlan,
} from "./conversation-store-types.js";

function parseJsonValue(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return parsed;
}

export function requireRowRecord(value: unknown, source: string): Readonly<Record<string, unknown>> {
  if (isRowRecord(value)) return value;
  throw new TypeError(`Expected ${source} row`);
}

function isRowRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  throw new TypeError(`Expected string column ${column}`);
}

function optionalString(row: Readonly<Record<string, unknown>>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new TypeError(`Expected nullable string column ${column}`);
}

function requireNumber(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  throw new TypeError(`Expected number column ${column}`);
}

function parseAuthorRole(value: unknown): ConversationAuthorRole {
  if (value === "user" || value === "assistant" || value === "system") return value;
  throw new TypeError("Expected conversation author role");
}

function parseDeliveryStatus(value: unknown): DeliveryPlan["status"] {
  if (value === "planned" || value === "committed") return value;
  throw new TypeError("Expected delivery plan status");
}

function parseStringArray(value: string): readonly string[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function parseNumberArray(value: string): readonly number[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is number => typeof item === "number");
}

function parseStringRecord(value: string): Readonly<Record<string, string>> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item === "string") record[key] = item;
  }
  return record;
}

export function sameStringRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function rawEventFromRow(row: Readonly<Record<string, unknown>>): ConversationRawEvent {
  return {
    id: requireNumber(row, "id"),
    scopeId: requireString(row, "scope_id"),
    channelId: requireString(row, "channel_id"),
    threadId: optionalString(row, "thread_id"),
    sessionId: optionalString(row, "session_id"),
    messageId: requireString(row, "message_id"),
    authorRole: parseAuthorRole(row.author_role),
    authorSource: requireString(row, "author_source"),
    text: requireString(row, "text"),
    eventTs: requireString(row, "event_ts"),
    observedAt: requireString(row, "observed_at"),
    botSelfLoop: Number(row.bot_self_loop) === 1,
    metadata: parseJsonValue(requireString(row, "metadata_json")),
    createdAt: requireString(row, "created_at"),
  };
}

export function checkpointFromRow(row: Readonly<Record<string, unknown>>): ConversationCheckpoint {
  return {
    scopeId: requireString(row, "scope_id"),
    channelId: requireString(row, "channel_id"),
    summary: requireString(row, "summary"),
    recentEventIds: parseNumberArray(requireString(row, "recent_event_ids_json")),
    updatedAt: requireString(row, "updated_at"),
  };
}

export function summaryFromRow(row: Readonly<Record<string, unknown>>): ConversationSummary {
  return {
    id: requireNumber(row, "id"),
    scopeId: requireString(row, "scope_id"),
    channelId: requireString(row, "channel_id"),
    summary: requireString(row, "summary"),
    sourceEventStartId: requireNumber(row, "source_event_start_id"),
    sourceEventEndId: requireNumber(row, "source_event_end_id"),
    createdAt: requireString(row, "created_at"),
  };
}

export function deliveryPlanFromRow(row: Readonly<Record<string, unknown>>): DeliveryPlan {
  return {
    planId: requireString(row, "plan_id"),
    scopeId: requireString(row, "scope_id"),
    channelId: requireString(row, "channel_id"),
    signalId: requireString(row, "signal_id"),
    cooldownKey: requireString(row, "cooldown_key"),
    requiredChunkIds: parseStringArray(requireString(row, "required_chunk_ids_json")),
    status: parseDeliveryStatus(row.status),
    deliveryMessageIds: parseStringRecord(requireString(row, "delivery_message_ids_json")),
    createdAt: requireString(row, "created_at"),
    committedAt: optionalString(row, "committed_at"),
  };
}

export function gateStateFromRow(row: Readonly<Record<string, unknown>>): ConversationGateState {
  return {
    scopeId: requireString(row, "scope_id"),
    stateKey: requireString(row, "state_key"),
    cooldownUntil: optionalString(row, "cooldown_until"),
    budgetWindowStart: optionalString(row, "budget_window_start"),
    budgetCount: requireNumber(row, "budget_count"),
    lastSignalId: optionalString(row, "last_signal_id"),
    updatedAt: requireString(row, "updated_at"),
  };
}
