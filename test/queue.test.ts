import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkQueue } from '../src/queue.js';

test('runs with a concurrency limit and signals idle', async () => {
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  const q = new WorkQueue<number>(async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    done.push(n);
    running--;
  }, 2);
  for (let i = 0; i < 6; i++) assert.equal(q.push(i), true);
  await q.onIdle();
  assert.equal(peak, 2);
  assert.deepEqual(done.sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(q.size, 0);
  assert.equal(q.active, 0);
});

test('errors are reported and do not stop the queue', async () => {
  const errors: unknown[] = [];
  const q = new WorkQueue<number>(
    async (n) => {
      if (n === 1) throw new Error('bad');
    },
    1,
    (e) => errors.push(e),
  );
  q.push(1);
  q.push(2);
  await q.onIdle();
  assert.equal(errors.length, 1);
});

test('max size and close', async () => {
  const q = new WorkQueue<number>(() => new Promise((r) => setTimeout(r, 5)), 1, () => {}, 2);
  assert.equal(q.push(1), true); // starts immediately
  assert.equal(q.push(2), true);
  assert.equal(q.push(3), true);
  assert.equal(q.push(4), false);
  await q.close();
  assert.equal(q.push(5), false);
  await q.onIdle();
});

test('invalid concurrency', () => {
  assert.throws(() => new WorkQueue(async () => {}, 0), /concurrency/);
});
