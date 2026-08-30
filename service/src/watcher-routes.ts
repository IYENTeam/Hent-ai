import type { ConversationRuntime } from "./conversation-runtime.js";

type WatcherRouteRequest = {
  readonly method: string | undefined;
  readonly pathname: string;
  readonly body: unknown;
  readonly runtime: ConversationRuntime;
};

type WatcherRouteResponse = {
  readonly status: number;
  readonly body: unknown;
};

const WATCHER_RECORD_USER_PATH = "/v1/watcher/record-user";
const WATCHER_EVALUATE_PATH = "/v1/watcher/evaluate";
const WATCHER_COMMIT_DELIVERY_PATH = "/v1/watcher/commit-delivery";

export function isWatcherRoute(method: string | undefined, pathname: string): boolean {
  return method === "POST" && (
    pathname === WATCHER_RECORD_USER_PATH
    || pathname === WATCHER_EVALUATE_PATH
    || pathname === WATCHER_COMMIT_DELIVERY_PATH
  );
}

export async function handleWatcherRoute(request: WatcherRouteRequest): Promise<WatcherRouteResponse | null> {
  if (!isWatcherRoute(request.method, request.pathname)) return null;

  const record = readWatcherRecord(request.body);
  switch (request.pathname) {
    case WATCHER_RECORD_USER_PATH:
      return handleRecordUser(record, request.runtime);
    case WATCHER_EVALUATE_PATH:
      return await handleEvaluate(record, request.runtime);
    case WATCHER_COMMIT_DELIVERY_PATH:
      return handleCommitDelivery(record, request.runtime);
    default:
      return null;
  }
}

function handleRecordUser(record: Record<string, unknown>, runtime: ConversationRuntime): WatcherRouteResponse {
  const scopeId = watcherString(record.scopeId);
  const text = watcherString(record.text);
  if (!scopeId || !text) return badRequestResponse("scopeId and text are required");

  return {
    status: 200,
    body: runtime.recordUser({
      scopeId,
      text,
      id: watcherString(record.id),
      channelId: watcherString(record.channelId),
      sourceThreadId: watcherString(record.sourceThreadId),
      sessionId: watcherString(record.sessionId),
    }),
  };
}

async function handleEvaluate(record: Record<string, unknown>, runtime: ConversationRuntime): Promise<WatcherRouteResponse> {
  const scopeId = watcherString(record.scopeId);
  const channelId = watcherString(record.channelId);
  const text = watcherString(record.text);
  const messageId = watcherString(record.messageId);
  if (!scopeId || !channelId || !text || !messageId) {
    return badRequestResponse("scopeId, channelId, text, and messageId are required");
  }

  return {
    status: 200,
    body: await runtime.evaluate({
      scopeId,
      channelId,
      text,
      messageId,
      sourceThreadId: watcherString(record.sourceThreadId),
      targetThreadId: watcherString(record.targetThreadId),
      sessionId: watcherString(record.sessionId),
      cooldownMs: Number(record.cooldownMs),
      privacyRisk: record.privacyRisk === true,
      crossThreadRisk: record.crossThreadRisk === true,
      deliveryMessageId: watcherString(record.deliveryMessageId),
    }),
  };
}

function handleCommitDelivery(record: Record<string, unknown>, runtime: ConversationRuntime): WatcherRouteResponse {
  if (record.planId !== undefined || record.deliveryMessageIds !== undefined) {
    return handleDeliveryPlanCommit(record, runtime);
  }

  const cooldownKey = watcherString(record.cooldownKey);
  const scopeId = watcherString(record.scopeId);
  const signalId = watcherString(record.signalId);
  const deliveryMessageId = watcherString(record.deliveryMessageId);
  if (!cooldownKey || !scopeId || !signalId || !deliveryMessageId) {
    return badRequestResponse("cooldownKey, scopeId, signalId, and deliveryMessageId are required");
  }

  runtime.commitDelivery({ cooldownKey, scopeId, signalId, deliveryMessageId });
  return { status: 200, body: { ok: true } };
}

function handleDeliveryPlanCommit(record: Record<string, unknown>, runtime: ConversationRuntime): WatcherRouteResponse {
  const planId = watcherString(record.planId);
  const cooldownKey = watcherString(record.cooldownKey);
  const scopeId = watcherString(record.scopeId);
  const signalId = watcherString(record.signalId);
  const deliveryMessageIds = watcherStringRecord(record.deliveryMessageIds);
  if (!planId || !cooldownKey || !scopeId || !signalId || !deliveryMessageIds) {
    return badRequestResponse("planId, cooldownKey, scopeId, signalId, and deliveryMessageIds are required");
  }

  const result = runtime.commitDeliveryPlan({ planId, cooldownKey, scopeId, signalId, deliveryMessageIds });
  switch (result.status) {
    case "committed":
    case "idempotent":
      return { status: 200, body: { ok: true, status: result.status } };
    case "missing_required_chunks":
      return {
        status: 409,
        body: { ok: false, retryable: true, error: "missing_required_chunks", missingChunkIds: result.missingChunkIds },
      };
    case "conflict":
      return { status: 409, body: { ok: false, retryable: false, error: "conflict" } };
    case "not_found":
      return { status: 404, body: { ok: false, retryable: true, error: "not_found" } };
    default:
      return assertNeverCommitResult(result);
  }
}

function watcherString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function watcherStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || !item.trim()) return undefined;
    record[key] = item.trim();
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function readWatcherRecord(body: unknown): Record<string, unknown> {
  return isWatcherRecord(body) ? body : {};
}

function isWatcherRecord(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

function badRequestResponse(message: string): WatcherRouteResponse {
  return { status: 400, body: { error: "bad_request", message } };
}

function assertNeverCommitResult(value: never): never {
  throw new Error(`Unhandled watcher commit result: ${String(value)}`);
}
