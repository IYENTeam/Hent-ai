import type { AdaptiveAmbientStore, Fence } from "./adaptive-ambient-store.js";

const HEARTBEAT_MS = 10_000;

export type HeartbeatScheduler = (run: () => void, intervalMs: number) => () => void;

export type ActiveWorkClaim = {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly stop: () => void;
};

export function createActiveWorkClaim(
  store: AdaptiveAmbientStore,
  workId: string,
  fence: Fence,
  callerSignal: AbortSignal,
  scheduleHeartbeat: HeartbeatScheduler = nativeHeartbeat,
): ActiveWorkClaim {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (callerSignal.aborted) abort();
  else callerSignal.addEventListener("abort", abort, { once: true });
  const cancel = scheduleHeartbeat(() => {
    try {
      if (!store.renewWorkClaim(workId, fence)) controller.abort(new Error("work claim renewal lost"));
    } catch {
      controller.abort(new Error("work claim renewal failed"));
    }
  }, HEARTBEAT_MS);

  return {
    get signal() { return controller.signal; },
    isCurrent() {
      if (controller.signal.aborted || callerSignal.aborted) return false;
      if (store.isWorkClaimCurrent(workId, fence)) return true;
      controller.abort(new Error("work claim expired"));
      return false;
    },
    stop() {
      cancel();
      callerSignal.removeEventListener("abort", abort);
    },
  };
}

function nativeHeartbeat(run: () => void, intervalMs: number): () => void {
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
