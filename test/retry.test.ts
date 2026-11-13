import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeadSyncError } from '../src/errors.js';
import { backoffDelay, withRetry } from '../src/retry.js';

test('retries retryable errors and returns the result', async () => {
  const delays: number[] = [];
  let calls = 0;
  const v = await withRetry(
    async (attempt) => {
      calls++;
      if (attempt < 3) throw new LeadSyncError('flaky', { retryable: true });
      return 'ok';
    },
    { sleep: async (ms) => void delays.push(ms), random: () => 0.5, baseDelayMs: 100 },
  );
  assert.equal(v, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [75, 150]);
});

test('does not retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new LeadSyncError('bad request');
    }, { sleep: async () => {} }),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test('gives up after the attempt budget and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new LeadSyncError(`fail ${calls}`, { retryable: true });
      },
      { attempts: 3, sleep: async () => {} },
    ),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('honours retryAfterMs hints, capped by maxDelayMs', async () => {
  const delays: number[] = [];
  let n = 0;
  await withRetry(
    async () => {
      if (n++ === 0) throw Object.assign(new LeadSyncError('429', { retryable: true }), { retryAfterMs: 99_000 });
      return 1;
    },
    { sleep: async (ms) => void delays.push(ms), maxDelayMs: 5000 },
  );
  assert.deepEqual(delays, [5000]);
});

test('custom shouldRetry and onRetry', async () => {
  const seen: number[] = [];
  let n = 0;
  await withRetry(
    async () => {
      if (n++ < 2) throw new Error('plain');
      return 1;
    },
    { shouldRetry: () => true, onRetry: (_e, attempt) => seen.push(attempt), sleep: async () => {} },
  );
  assert.deepEqual(seen, [1, 2]);
});

test('backoffDelay grows exponentially with jitter and a cap', () => {
  assert.equal(backoffDelay(1, 100, 10_000, () => 0), 50);
  assert.equal(backoffDelay(1, 100, 10_000, () => 0.999), 100);
  assert.equal(backoffDelay(4, 100, 10_000, () => 0), 400);
  assert.equal(backoffDelay(20, 100, 1000, () => 0), 500);
});
