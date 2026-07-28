import type { AdaptiveAmbientStore, Fence, ServiceClock } from "./adaptive-ambient-store.js";
import type { DiscordParticipantClient } from "./discord-participant-client.js";

const PREFERRED_BUBBLE_CHARS = 140;
const DISCORD_BUBBLE_MAX_CHARS = 1800;
const MIN_DELAY_MS = 250;
const MAX_DELAY_MS = 1800;

type Delay = (ms: number, signal: AbortSignal) => Promise<void>;
type DeliveryStatus = "aborted" | "cancelled" | "delivered" | "missing" | "retryable";

export type DiscordAmbientDeliveryOptions = {
  readonly store: AdaptiveAmbientStore;
  readonly client: Pick<DiscordParticipantClient, "sendTyping" | "createMessage">;
  readonly clock?: ServiceClock;
  readonly delay?: Delay;
  /** Re-evaluated immediately before every Discord side effect. */
  readonly isAuthorized?: (channelId: string) => boolean;
};

export type DiscordAmbientDelivery = {
  readonly deliver: (input: { readonly planId: string; readonly fence: Fence; readonly signal: AbortSignal }) => Promise<DeliveryStatus>;
};

export function createDiscordAmbientDelivery(options: DiscordAmbientDeliveryOptions): DiscordAmbientDelivery {
  const delay = options.delay ?? delayWithAbort;
  const isAuthorized = options.isAuthorized ?? (() => true);

  async function deliver(input: { readonly planId: string; readonly fence: Fence; readonly signal: AbortSignal }): Promise<DeliveryStatus> {
    if (!current(options.store, input.fence, input.signal)) return "aborted";
    const plan = options.store.deliveryPlan(input.planId);
    if (!plan) return "missing";
    if (plan.status === "delivered") return "delivered";
    if (plan.status === "cancelled") return "cancelled";

    for (const chunk of plan.chunks) {
      if (chunk.receipt) continue;
      if (!current(options.store, input.fence, input.signal)) return "aborted";
      if (!isAuthorized(plan.channelId)) {
        if (!current(options.store, input.fence, input.signal)) return "aborted";
        try { return options.store.cancelDelivery(plan.id, input.fence) ? "cancelled" : "aborted"; } catch (error) { if (!current(options.store, input.fence, input.signal)) return "aborted"; throw error; }
      }
      try {
        if (!current(options.store, input.fence, input.signal)) return "aborted";
        if (!isAuthorized(plan.channelId)) return options.store.cancelDelivery(plan.id, input.fence) ? "cancelled" : "aborted";
        await options.client.sendTyping(plan.channelId, input.signal);
        if (!current(options.store, input.fence, input.signal)) return "aborted";
        await delay(delayForBubble(chunk.content), input.signal);
        if (!current(options.store, input.fence, input.signal)) return "aborted";
        if (!isAuthorized(plan.channelId)) return options.store.cancelDelivery(plan.id, input.fence) ? "cancelled" : "aborted";
        const message = await options.client.createMessage(plan.channelId, chunk.content, chunk.nonce, input.signal);
        if (!current(options.store, input.fence, input.signal)) return "aborted";
        if (!options.store.recordReceipt(plan.id, chunk.index, chunk.nonce, message.id, input.fence)) return "aborted";
      } catch {
        if (!current(options.store, input.fence, input.signal)) return "aborted";
        try { return options.store.markDeliveryRetryable(plan.id, input.fence) ? "retryable" : "aborted"; } catch (error) { if (!current(options.store, input.fence, input.signal)) return "aborted"; throw error; }
      }
    }
    if (!current(options.store, input.fence, input.signal)) return "aborted";
    try {
      const final = options.store.finalizeDelivery(plan.id, input.fence);
      return final === "delivered" || final === "idempotent" ? "delivered" : final === "incomplete" ? "retryable" : "aborted";
    } catch (error) { if (!current(options.store, input.fence, input.signal)) return "aborted"; throw error; }
  }

  return { deliver };
}

export function normalizeDiscordAmbientBubbles(chunks: readonly string[]): readonly string[] | null {
  if (chunks.length < 1 || chunks.length > 5) return null;
  const bubbles: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk !== "string" || chunk.trim().length === 0 || chunk.length > DISCORD_BUBBLE_MAX_CHARS) return null;
    let remaining = chunk;
    while (remaining.length > PREFERRED_BUBBLE_CHARS) {
      const breakAt = preferredBreak(remaining);
      bubbles.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt);
    }
    if (remaining.length > 0) bubbles.push(remaining);
  }
  const normalized = mergeWhitespaceOnlyBubbles(bubbles);
  return normalized && normalized.length <= 5 && normalized.every((bubble) => bubble.length <= DISCORD_BUBBLE_MAX_CHARS && bubble.trim().length > 0) ? normalized : null;
}

export function delayForDiscordAmbientBubble(content: string): number { return delayForBubble(content); }

function preferredBreak(content: string): number {
  const space = content.lastIndexOf(" ", PREFERRED_BUBBLE_CHARS);
  return space > 0 ? space + 1 : PREFERRED_BUBBLE_CHARS;
}

function mergeWhitespaceOnlyBubbles(bubbles: readonly string[]): readonly string[] | null {
  const merged: string[] = [];
  for (const bubble of bubbles) {
    if (bubble.trim().length > 0) { merged.push(bubble); continue; }
    const previous = merged.at(-1);
    if (previous === undefined || previous.length + bubble.length > DISCORD_BUBBLE_MAX_CHARS) return null;
    merged[merged.length - 1] = previous + bubble;
  }
  return merged;
}

function current(store: AdaptiveAmbientStore, fence: Fence, signal: AbortSignal): boolean { return !signal.aborted && store.isFenceCurrent(fence); }
function delayForBubble(content: string): number { return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, content.length * 5)); }
function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    function done(): void { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted(): void { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
