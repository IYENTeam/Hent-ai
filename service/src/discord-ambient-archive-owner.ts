import type { AdaptiveAmbientStore, Fence } from "./adaptive-ambient-store.js";

const HEARTBEAT_MS = 10_000;
type Timer = { readonly setInterval: (callback: () => void, ms: number) => unknown; readonly clearInterval: (handle: unknown) => void };
type Scheduler = { readonly ready: Promise<unknown>; readonly stop: () => void };

export type DiscordAmbientArchiveOwner = {
  readonly activate: () => Promise<boolean>;
  readonly stop: () => void;
};

export function createDiscordAmbientArchiveOwner(options: {
  readonly store: AdaptiveAmbientStore;
  readonly holderId: string;
  readonly timer: Timer;
  readonly createScheduler: (fence: Fence, signal: AbortSignal) => Scheduler;
  readonly onLeaseLost: () => void;
  readonly onSchedulerFailure: () => void;
}): DiscordAmbientArchiveOwner {
  const key = "discord-ambient-archive-worker";
  let fence = options.store.acquireLease(key, options.holderId);
  const hadInitialLease = fence !== null;
  let active = false;
  let stopped = false;
  let scheduler: Scheduler | null = null;
  let controller: AbortController | null = null;
  const heartbeat = options.timer.setInterval(() => { void tick(); }, HEARTBEAT_MS);

  function matches(current: Fence): boolean {
    return fence?.holderId === current.holderId && fence.fenceToken === current.fenceToken;
  }

  function stopScheduler(): void {
    controller?.abort(); controller = null;
    scheduler?.stop(); scheduler = null;
  }

  function lose(current: Fence): void {
    if (!matches(current)) return;
    options.store.recordUnfencedDiagnostic(current, "archive worker lease renewal failed");
    fence = null;
    stopScheduler();
    options.store.releaseLease(current);
    options.onLeaseLost();
  }

  function release(current: Fence): void {
    if (!matches(current)) return;
    fence = null;
    stopScheduler();
    options.store.releaseLease(current);
  }

  async function start(current: Fence): Promise<boolean> {
    if (stopped || !active || !matches(current) || scheduler) return matches(current);
    const nextController = new AbortController();
    controller = nextController;
    try {
      scheduler = options.createScheduler(current, nextController.signal);
      await scheduler.ready;
      return matches(current) && !nextController.signal.aborted;
    } catch {
      if (matches(current)) {
        release(current);
        options.onSchedulerFailure();
      }
      return false;
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (fence) {
      try {
        const renewed = options.store.renewLease(fence);
        if (renewed) { fence = renewed; return; }
      } catch { /* fail closed below */ }
      lose(fence);
      return;
    }
    try { fence = options.store.acquireLease(key, options.holderId); } catch { return; }
    if (fence && active) await start(fence);
  }

  return {
    async activate(): Promise<boolean> {
      active = true;
      if (!fence) return !hadInitialLease;
      return start(fence);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      options.timer.clearInterval(heartbeat);
      const current = fence;
      fence = null;
      stopScheduler();
      if (current) options.store.releaseLease(current);
    },
  };
}
