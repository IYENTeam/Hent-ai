import { CodexRpcError, type CodexRpc } from "./codex-rpc.ts";

export type QueueRpc = Pick<CodexRpc, "request" | "subscribe" | "onClose" | "close">;
export type QueuedWake = { readonly id: string; readonly wakeId: string };
export const wakeText = (wakeId: string): string => `[hent] WAKE ${wakeId}; run hent inbox next --wake ${wakeId}`;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CodexRpcError("Expected Codex response object");
  return Object.fromEntries(Object.entries(value));
}

/** Only our exact machine-generated marker identifies queue entries we may delete. */
export async function queuedWakes(rpc: QueueRpc, threadId: string): Promise<QueuedWake[]> {
  const result: QueuedWake[] = [];
  let cursor: string | null = null;
  do {
    const page = object(await rpc.request("thread/queue/list", { threadId, cursor, limit: 100 }));
    if (!Array.isArray(page.data) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
      throw new CodexRpcError("Invalid Codex queue page");
    }
    for (const raw of page.data) {
      const entry = object(raw);
      if (typeof entry.id !== "string" || typeof entry.clientUserMessageId !== "string" || !Array.isArray(entry.input)) {
        throw new CodexRpcError("Invalid Codex queue entry");
      }
      const [part] = entry.input;
      const input = part === undefined ? null : object(part);
      if (entry.input.length === 1 && input?.type === "text" && input.text === wakeText(entry.clientUserMessageId)) {
        result.push({ id: entry.id, wakeId: entry.clientUserMessageId });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return result;
}

export async function threadState(rpc: QueueRpc, threadId: string): Promise<"idle" | "active" | "notLoaded" | "systemError"> {
  const response = object(await rpc.request("thread/read", { threadId, includeTurns: false }));
  const state = object(object(response.thread).status).type;
  if (state !== "idle" && state !== "active" && state !== "notLoaded" && state !== "systemError") {
    throw new CodexRpcError("Invalid Codex thread status");
  }
  return state;
}

export async function enqueueWake(rpc: QueueRpc, wake: { readonly sessionId: string; readonly wakeId: string }): Promise<string> {
  const response = object(await rpc.request("thread/queue/add", {
    threadId: wake.sessionId,
    clientUserMessageId: wake.wakeId,
    input: [{ type: "text", text: wakeText(wake.wakeId), text_elements: [] }],
  }));
  const id = object(response.queuedSubmission).id;
  if (typeof id !== "string") throw new CodexRpcError("Invalid Codex queued submission");
  return id;
}

export async function deleteWake(rpc: QueueRpc, threadId: string, id: string): Promise<void> {
  const response = object(await rpc.request("thread/queue/delete", { threadId, queuedSubmissionId: id }));
  if (typeof response.deleted !== "boolean") throw new CodexRpcError("Invalid Codex queue deletion");
}
