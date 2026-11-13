import { LeadSyncError } from './errors.js';
import { defaultSleep, type SleepFn } from './types.js';

export interface RetryOptions {
  /** Total attempts including the first one. Default 4. */
  attempts?: number;
  /** Delay before the first retry in ms. Default 500. */
  baseDelayMs?: number;
  /** Upper bound for one delay in ms. Default 15000. */
  maxDelayMs?: number;
  /** Decide whether an error is worth another attempt. Default: `error.retryable === true`. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry, for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: SleepFn;
  /** Returns a number in [0, 1). Injectable for deterministic tests. */
  random?: () => number;
}

/** Read a delay hint (`retryAfterMs`) that some errors carry, such as Telegram's `retry_after`. */
function hintedDelay(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'retryAfterMs' in error) {
    const v = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  // "Full jitter": a random delay between 50% and 100% of the exponential step.
  const step = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

/**
 * Run `fn` until it succeeds, the error is not retryable, or `attempts` is reached.
 * The last error is rethrown unchanged.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? ((e: unknown) => e instanceof LeadSyncError && e.retryable);

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error, attempt)) throw error;
      const hinted = hintedDelay(error);
      const delay = hinted !== undefined ? Math.min(hinted, max) : backoffDelay(attempt, base, max, random);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}
