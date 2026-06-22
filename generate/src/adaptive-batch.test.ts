import { describe, expect, it } from "vitest";
import { runAdaptiveBatch, type AdaptiveBatchEvent } from "./adaptive-batch.js";

class RateLimitError extends Error {
  constructor() {
    super("HTTP 429 rate limit");
  }
}

describe("runAdaptiveBatch", () => {
  it("runs work with bounded concurrency and preserves result order", async () => {
    let inFlight = 0;
    let peakInFlight = 0;

    const result = await runAdaptiveBatch({
      items: [1, 2, 3, 4],
      initialConcurrency: 2,
      maxConcurrency: 2,
      isRetryableError: () => false,
      worker: async (item) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return item * 10;
      },
    });

    expect(result.results).toEqual([10, 20, 30, 40]);
    expect(result.peakConcurrency).toBe(2);
    expect(peakInFlight).toBe(2);
  });

  it("backs off and retries when a retryable rate-limit error appears", async () => {
    const attempts = new Map<number, number>();
    const events: AdaptiveBatchEvent[] = [];

    const result = await runAdaptiveBatch({
      items: [1, 2, 3],
      initialConcurrency: 3,
      maxConcurrency: 3,
      maxAttempts: 2,
      retryDelayMs: 0,
      isRetryableError: (error) => error instanceof RateLimitError,
      onEvent: (event) => events.push(event),
      worker: async (item) => {
        const nextAttempt = (attempts.get(item) ?? 0) + 1;
        attempts.set(item, nextAttempt);
        await Promise.resolve();
        if (item === 2 && nextAttempt === 1) {
          throw new RateLimitError();
        }
        return item;
      },
    });

    expect(result.results).toEqual([1, 2, 3]);
    expect(attempts.get(2)).toBe(2);
    expect(events).toContainEqual({
      type: "backoff",
      itemIndex: 1,
      attempt: 1,
      nextConcurrency: 1,
    });
    expect(result.recommendedConcurrency).toBeLessThanOrEqual(2);
  });

  it("adds jitter to initial starts and retry backoff", async () => {
    const sleeps: number[] = [];
    const attempts = new Map<number, number>();

    const result = await runAdaptiveBatch({
      items: [1, 2],
      initialConcurrency: 2,
      maxConcurrency: 2,
      maxAttempts: 2,
      initialJitterMs: 100,
      retryDelayMs: 10,
      retryJitterMs: 50,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      isRetryableError: (error) => error instanceof RateLimitError,
      worker: async (item) => {
        const nextAttempt = (attempts.get(item) ?? 0) + 1;
        attempts.set(item, nextAttempt);
        await Promise.resolve();
        if (item === 1 && nextAttempt === 1) {
          throw new RateLimitError();
        }
        return item;
      },
    });

    expect(result.results).toEqual([1, 2]);
    expect(sleeps).toEqual([50, 50, 35, 0]);
  });
});
