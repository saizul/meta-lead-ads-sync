import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { JsonFileStore, MemoryStore, SqliteStore, openStore, sqliteAvailable, type IdempotencyStore } from '../src/store/index.js';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mlas-'));
  dirs.push(d);
  return d;
}
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;
const info = (now = T0) => ({ now, staleMs: 60_000, pageId: '1', formId: '2' });

function contract(name: string, open: () => Promise<IdempotencyStore>, skip = false) {
  describe(`${name} store`, { skip }, () => {
    test('claim, duplicate and in-progress', async () => {
      const s = await open();
      const first = await s.claim('100', info());
      assert.equal(first.claimed, true);
      assert.equal(first.record.status, 'processing');
      assert.equal(first.record.attempts, 1);
      assert.equal(first.record.pageId, '1');
      const busy = await s.claim('100', info(T0 + 1000));
      assert.deepEqual([busy.claimed, !busy.claimed && busy.reason], [false, 'in-progress']);
      await s.put('100', { ...first.record, status: 'done', delivered: ['sheet'], updatedAt: T0 + 2000 });
      const dup = await s.claim('100', info(T0 + 3000));
      assert.deepEqual([dup.claimed, !dup.claimed && dup.reason], [false, 'done']);
      assert.deepEqual((await s.get('100'))?.delivered, ['sheet']);
      await s.close();
    });

    test('stale processing and failed records can be claimed again', async () => {
      const s = await open();
      await s.claim('200', info());
      const takeover = await s.claim('200', info(T0 + 120_000));
      assert.equal(takeover.claimed, true);
      assert.equal(takeover.record.attempts, 2);
      await s.put('200', { ...takeover.record, status: 'partial', delivered: ['a'] });
      const again = await s.claim('200', info(T0 + 121_000));
      assert.equal(again.claimed, true);
      assert.deepEqual(again.record.delivered, ['a']);
      assert.equal(again.record.attempts, 3);
      await s.close();
    });

    test('pending, stats, delete and prune', async () => {
      const s = await open();
      const base = { delivered: [], firstSeenAt: T0, pageId: '1' };
      await s.put('1', { ...base, status: 'done', attempts: 1, updatedAt: T0 });
      await s.put('2', { ...base, status: 'failed', attempts: 1, updatedAt: T0 });
      await s.put('3', { ...base, status: 'partial', attempts: 9, updatedAt: T0 });
      await s.put('4', { ...base, status: 'processing', attempts: 1, updatedAt: T0 });
      await s.put('5', { ...base, status: 'processing', attempts: 1, updatedAt: T0 + 500_000 });
      const pending = await s.pending({ maxAttempts: 5, staleBefore: T0 + 1 });
      assert.deepEqual(pending.map(([id]) => id).sort(), ['2', '4']);
      assert.equal((await s.pending({ maxAttempts: 5, staleBefore: T0 + 1, limit: 1 })).length, 1);
      assert.deepEqual(await s.stats(), { processing: 2, done: 1, partial: 1, failed: 1 });
      assert.equal(await s.delete('1'), true);
      assert.equal(await s.delete('1'), false);
      assert.equal(await s.get('1'), undefined);
      // Processing records are never pruned.
      assert.equal(await s.prune(T0 + 1), 2);
      assert.deepEqual((await s.stats()).processing, 2);
      await s.close();
    });
  });
}

contract('memory', async () => new MemoryStore());
contract('json', async () => JsonFileStore.open(join(await tmp(), 'nested', 'leads.json')));
contract('sqlite', async () => SqliteStore.open(join(await tmp(), 'leads.sqlite')), !(await sqliteAvailable()));

test('json store persists across reopen with private permissions', async () => {
  const path = join(await tmp(), 'leads.json');
  const a = await JsonFileStore.open(path);
  await a.claim('900', info());
  await a.close();
  const b = await JsonFileStore.open(path);
  assert.equal((await b.get('900'))?.status, 'processing');
  const data = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(data.version, 1);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('json store serialises concurrent writes', async () => {
  const path = join(await tmp(), 'leads.json');
  const s = await JsonFileStore.open(path);
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.claim(String(1000 + i), info())));
  await s.close();
  const reopened = await JsonFileStore.open(path);
  assert.equal(reopened.size, 50);
});

test('json store refuses a corrupt file', async () => {
  const path = join(await tmp(), 'leads.json');
  await writeFile(path, '{oops');
  await assert.rejects(JsonFileStore.open(path), /not valid JSON/);
});

test('json store treats an empty file as empty', async () => {
  const path = join(await tmp(), 'leads.json');
  await writeFile(path, '');
  assert.equal((await JsonFileStore.open(path)).size, 0);
});

test('sqlite store persists across reopen', { skip: !(await sqliteAvailable()) }, async () => {
  const path = join(await tmp(), 'leads.sqlite');
  const a = await SqliteStore.open(path);
  await a.claim('77', info());
  await a.close();
  const b = await SqliteStore.open(path);
  assert.equal((await b.get('77'))?.attempts, 1);
  await b.close();
});

test('openStore', async () => {
  const dir = await tmp();
  assert.ok((await openStore({ type: 'memory' })) instanceof MemoryStore);
  assert.ok((await openStore({ type: 'json', path: join(dir, 'a.json') })) instanceof JsonFileStore);
  await assert.rejects(openStore({ type: 'redis' } as never), /unknown store type/);
});
