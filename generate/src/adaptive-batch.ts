export type AdaptiveBatchEvent =
  | {
    readonly type: "backoff";
    readonly itemIndex: number;
    readonly attempt: number;
    readonly nextConcurrency: number;
  }
  | {
    readonly type: "increase";
    readonly nextConcurrency: number;
  };

export interface AdaptiveBatchOptions<TItem, TResult> {
  readonly items: readonly TItem[];
  readonly initialConcurrency: number;
  readonly maxConcurrency: number;
  readonly minConcurrency?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly retryJitterMs?: number;
  readonly initialJitterMs?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly worker: (item: TItem, itemIndex: number, attempt: number) => Promise<TResult>;
  readonly isRetryableError: (error: unknown) => boolean;
  readonly onEvent?: (event: AdaptiveBatchEvent) => void;
}

export interface AdaptiveBatchResult<TResult> {
  readonly results: readonly TResult[];
  readonly peakConcurrency: number;
  readonly recommendedConcurrency: number;
}

class InvalidAdaptiveBatchConcurrencyError extends Error {
  constructor(label: string, value: number) {
    super(`${label} must be a positive integer, got ${value}`);
  }
}

class IncompleteAdaptiveBatchError extends Error {
  constructor(itemIndex: number) {
    super(`Adaptive batch finished without result for item index ${itemIndex}`);
  }
}

class InvalidAdaptiveBatchDelayError extends Error {
  constructor(label: string, value: number) {
    super(`${label} must be a non-negative integer, got ${value}`);
  }
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidAdaptiveBatchConcurrencyError(label, value);
  }
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidAdaptiveBatchDelayError(label, value);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithJitter(
  baseDelayMs: number,
  jitterMs: number,
  random: () => number,
): number {
  return baseDelayMs + Math.floor(random() * (jitterMs + 1));
}

export async function runAdaptiveBatch<TItem, TResult>(
  options: AdaptiveBatchOptions<TItem, TResult>,
): Promise<AdaptiveBatchResult<TResult>> {
  const minConcurrency = options.minConcurrency ?? 1;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 0;
  const retryJitterMs = options.retryJitterMs ?? 0;
  const initialJitterMs = options.initialJitterMs ?? 0;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? wait;

  assertPositiveInteger("minConcurrency", minConcurrency);
  assertPositiveInteger("initialConcurrency", options.initialConcurrency);
  assertPositiveInteger("maxConcurrency", options.maxConcurrency);
  assertPositiveInteger("maxAttempts", maxAttempts);
  assertNonNegativeInteger("retryDelayMs", retryDelayMs);
  assertNonNegativeInteger("retryJitterMs", retryJitterMs);
  assertNonNegativeInteger("initialJitterMs", initialJitterMs);

  if (options.items.length === 0) {
    return { results: [], peakConcurrency: 0, recommendedConcurrency: minConcurrency };
  }

  let currentConcurrency = clamp(
    options.initialConcurrency,
    minConcurrency,
    options.maxConcurrency,
  );
  let active = 0;
  let peakConcurrency = 0;
  let successesSinceAdjustment = 0;
  let settled = false;

  const queue = options.items.map((_item, index) => index);
  const attempts = new Map<number, number>();
  const results = new Map<number, { readonly value: TResult }>();

  return new Promise<AdaptiveBatchResult<TResult>>((resolve, reject) => {
    const finishIfDone = (): boolean => {
      if (results.size !== options.items.length) return false;

      const ordered: TResult[] = [];
      for (let index = 0; index < options.items.length; index++) {
        const result = results.get(index);
        if (!result) {
          reject(new IncompleteAdaptiveBatchError(index));
          return true;
        }
        ordered.push(result.value);
      }

      settled = true;
      resolve({
        results: ordered,
        peakConcurrency,
        recommendedConcurrency: currentConcurrency,
      });
      return true;
    };

    const schedule = (): void => {
      if (settled || finishIfDone()) return;

      while (active < currentConcurrency && queue.length > 0) {
        const itemIndex = queue.shift();
        if (itemIndex === undefined) return;

        const attempt = (attempts.get(itemIndex) ?? 0) + 1;
        attempts.set(itemIndex, attempt);
        active += 1;
        peakConcurrency = Math.max(peakConcurrency, active);
        const startDelayMs = attempt === 1
          ? delayWithJitter(0, initialJitterMs, random)
          : 0;

        sleep(startDelayMs).then(() => options.worker(options.items[itemIndex], itemIndex, attempt)).then(
          (value) => {
            if (settled) return;
            active -= 1;
            results.set(itemIndex, { value });
            successesSinceAdjustment += 1;

            if (
              successesSinceAdjustment >= currentConcurrency &&
              currentConcurrency < options.maxConcurrency
            ) {
              currentConcurrency += 1;
              successesSinceAdjustment = 0;
              options.onEvent?.({
                type: "increase",
                nextConcurrency: currentConcurrency,
              });
            }

            schedule();
          },
          (error: unknown) => {
            if (settled) return;
            active -= 1;

            if (options.isRetryableError(error) && attempt < maxAttempts) {
              currentConcurrency = Math.max(
                minConcurrency,
                Math.floor(currentConcurrency / 2),
              );
              successesSinceAdjustment = 0;
              options.onEvent?.({
                type: "backoff",
                itemIndex,
                attempt,
                nextConcurrency: currentConcurrency,
              });

              const nextRetryDelayMs = delayWithJitter(
                retryDelayMs,
                retryJitterMs,
                random,
              );
              void sleep(nextRetryDelayMs).then(() => {
                if (settled) return;
                queue.push(itemIndex);
                schedule();
              });
              return;
            }

            settled = true;
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }
    };

    schedule();
  });
}
