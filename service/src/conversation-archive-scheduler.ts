import type { Fence, AdaptiveAmbientStore, ServiceClock } from "./adaptive-ambient-store.js";
import { buildMemoryCompactionPrompt, parseMemoryCompactionResponse } from "./conversation-contracts.js";
import type { ConversationMemoryCompactionProvider } from "./conversation-memory.js";
import type { PersistedArchiveBatch } from "./conversation-store-archive.js";
import type { ConversationArchiveCandidateGroup, ConversationRawEvent, ConversationStore } from "./conversation-store.js";

const ARCHIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ArchiveTimer = { readonly setInterval: (callback: () => void, intervalMs: number) => unknown; readonly clearInterval: (handle: unknown) => void };
export type ConversationArchiveSchedulerOptions = {
  readonly store: ConversationStore; readonly archiveStore: AdaptiveAmbientStore; readonly provider: ConversationMemoryCompactionProvider;
  readonly fence: Fence; readonly rawRetentionDays: number; readonly clock: ServiceClock; readonly signal?: AbortSignal;
  /** Non-Discord callers retain authorize-all behavior; worker composition supplies a live scope fence. */
  readonly isScopeAuthorized?: (scopeId: string) => boolean;
  readonly timer?: ArchiveTimer; readonly onError?: (error: unknown) => void;
};
export type ConversationArchivePassResult = { readonly claimedBatchCount: number; readonly completedBatchCount: number; readonly retryableBatchCount: number };
export type ConversationArchiveScheduler = { readonly ready: Promise<ConversationArchivePassResult>; readonly run: () => Promise<ConversationArchivePassResult>; readonly stop: () => void };
type ArchiveWork = { readonly batchKey: string; readonly summaryKey: string; readonly group: ConversationArchiveCandidateGroup };

export function createConversationArchiveScheduler(options: ConversationArchiveSchedulerOptions): ConversationArchiveScheduler {
  const timer: ArchiveTimer = options.timer ?? { setInterval: (callback, intervalMs) => setInterval(callback, intervalMs), clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout) };
  let running: Promise<ConversationArchivePassResult> | null = null;
  const run = (): Promise<ConversationArchivePassResult> => {
    if (running !== null) return running;
    running = runArchivePass(options).finally(() => { running = null; });
    return running;
  };
  const ready = run();
  const handle = timer.setInterval(() => { void run().catch((error: unknown) => options.onError?.(error)); }, ARCHIVE_INTERVAL_MS);
  return { ready, run, stop: () => timer.clearInterval(handle) };
}

async function runArchivePass(options: ConversationArchiveSchedulerOptions): Promise<ConversationArchivePassResult> {
  const cutoff = new Date(options.clock() - options.rawRetentionDays * MS_PER_DAY).toISOString();
  const result = { claimedBatchCount: 0, completedBatchCount: 0, retryableBatchCount: 0 };
  for (const batch of options.store.listClaimableArchiveBatches(options.clock())) {
    const work = persistedWork(options.store.loadArchiveBatchEvents(batch), batch);
    if (work) await processWork(options, work, result);
  }
  for (const group of options.store.listArchiveCandidateGroups(cutoff)) {
    const first = group.events[0]; const last = group.events.at(-1);
    if (first && last) await processWork(options, { batchKey: archiveBatchKey(group), summaryKey: `archive-summary-v1:${archiveBatchKey(group)}`, group }, result);
  }
  return result;
}

async function processWork(options: ConversationArchiveSchedulerOptions, work: ArchiveWork, result: { claimedBatchCount: number; completedBatchCount: number; retryableBatchCount: number }): Promise<void> {
  if (options.signal?.aborted || !authorized(options, work.group.scopeId)) return;
  const first = work.group.events[0]; const last = work.group.events.at(-1);
  if (!first || !last || !options.archiveStore.claimArchiveBatch({ batchKey: work.batchKey, summaryKey: work.summaryKey, scopeId: work.group.scopeId, sourceStartId: first.id, sourceEndId: last.id, sourceEventIds: work.group.events.map((event) => event.id), fence: options.fence })) return;
  result.claimedBatchCount += 1;
  if (!authorized(options, work.group.scopeId)) { options.archiveStore.retryArchiveBatch(work.batchKey, options.fence); return; }
  const summary = await compactGroup(options.provider, work.group);
  if (options.signal?.aborted) return;
  if (summary === null) {
    if (options.archiveStore.retryArchiveBatch(work.batchKey, options.fence)) result.retryableBatchCount += 1;
  } else if (options.archiveStore.completeArchiveBatch(work.batchKey, summary, options.fence, work.group.events.map((event) => event.id))) result.completedBatchCount += 1;
}

function persistedWork(events: readonly ConversationRawEvent[], batch: PersistedArchiveBatch): ArchiveWork | null {
  if (events.length !== batch.sourceEventIds.length || events.some((event, index) => event.id !== batch.sourceEventIds[index]) || events.some((event) => event.scopeId !== batch.scopeId)) return null;
  const first = events[0]; const last = events.at(-1);
  if (!first || !last || first.id !== batch.sourceStartId || last.id !== batch.sourceEndId || !inConversationOrder(events)) return null;
  return { batchKey: batch.batchKey, summaryKey: batch.summaryKey, group: { scopeId: batch.scopeId, channelId: first.channelId, threadId: first.threadId, sessionId: first.sessionId, events } };
}

function inConversationOrder(events: readonly ConversationRawEvent[]): boolean {
  return events.every((event, index) => {
    if (index === 0) return true;
    const previous = events[index - 1]!;
    return previous.eventTs < event.eventTs || (previous.eventTs === event.eventTs && previous.id < event.id);
  });
}

async function compactGroup(provider: ConversationMemoryCompactionProvider, group: ConversationArchiveCandidateGroup): Promise<string | null> {
  const first = group.events[0];
  if (!first) return null;
  try {
    const text = await provider.compact({ prompt: buildMemoryCompactionPrompt({
      scope: { scopeId: group.scopeId, channelId: group.channelId, ...(group.threadId ? { threadId: group.threadId } : {}), ...(group.sessionId ? { sessionId: group.sessionId } : {}) },
      olderTurns: group.events.map((event) => ({ scopeId: group.scopeId, channelId: group.channelId, ...(group.threadId ? { threadId: group.threadId } : {}), ...(group.sessionId ? { sessionId: group.sessionId } : {}), author: event.authorRole === "user" ? "user" : "assistant", content: event.text, observedAtMs: new Date(event.observedAt).getTime() })),
    }), scope: { scopeId: group.scopeId, channelId: group.channelId, ...(group.threadId ? { threadId: group.threadId } : {}), ...(group.sessionId ? { sessionId: group.sessionId } : {}) }, sourceEvents: group.events });
    const parsed = parseMemoryCompactionResponse(text);
    return parsed.kind === "ok" && parsed.value.scopeId === first.scopeId ? parsed.value.summary : null;
  } catch { return null; }
}

function authorized(options: ConversationArchiveSchedulerOptions, scopeId: string): boolean { return options.isScopeAuthorized?.(scopeId) ?? true; }

function archiveBatchKey(group: ConversationArchiveCandidateGroup): string {
  const first = group.events[0]; const last = group.events.at(-1);
  if (!first || !last) throw new Error("archive batch must contain an event");
  return `archive-v1:${group.scopeId}:${first.id}:${last.id}`;
}
