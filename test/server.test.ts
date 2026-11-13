import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createApp, type App } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { WorkQueue } from '../src/queue.js';
import { createHttpServer } from '../src/server.js';
import { signPayload } from '../src/signature.js';
import { MemoryStore } from '../src/store/memory.js';
import type { LeadgenEvent } from '../src/types.js';
import { APP_SECRET, PAGE_TOKEN, VERIFY_TOKEN, lead, leadId, webhookBody } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

const ADMIN = 'admin-token-0123456789abcdef';
const BOT = '123456:ABC-test_token';
const N8N = 'https://n8n.example.com/webhook/leads';

function config(extra: Record<string, unknown> = {}) {
  return parseConfig({
    server: { host: '127.0.0.1', port: 0, adminToken: ADMIN, ...((extra.server as object) ?? {}) },
    meta: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, accessToken: PAGE_TOKEN },
    store: { type: 'memory' },
    sinks: [
      { type: 'webhook', name: 'n8n', url: N8N },
      { type: 'telegram', botToken: BOT, chatId: '42' },
    ],
    processing: { retryIntervalSeconds: 0 },
    logLevel: 'silent',
  });
}

function graphAndSinks(mock: MockFetch) {
  mock.on('GET', /graph\.facebook\.com\/v27\.0\/(\d+)/, (call) => ({ json: lead(new URL(call.url).pathname.split('/').pop()!) }));
  mock.on('POST', N8N, { text: 'ok' });
  mock.on('POST', /api\.telegram\.org/, { json: { ok: true } });
  return mock;
}

interface Res {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function http(port: number, method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function signed(port: number, payload: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  return http(port, 'POST', '/webhook', raw, { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(raw, secret) });
}

describe('webhook server (immediate ack)', () => {
  let app: App;
  let port: number;
  const mock = graphAndSinks(new MockFetch());
  const store = new MemoryStore();

  before(async () => {
    app = await createApp(config(), { fetch: mock.fetch, store, logger: silentLogger, sleep: noSleep });
    port = await app.listen();
  });
  after(() => app.close());

  test('GET verification', async () => {
    const ok = await http(port, 'GET', `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '1158201444');
    assert.match(String(ok.headers['content-type']), /text\/plain/);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    const bad = await http(port, 'GET', '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1');
    assert.equal(bad.status, 403);
  });

  test('a signed notification is acknowledged and delivered to every sink', async () => {
    const res = await signed(port, webhookBody([leadId(1), leadId(2)]));
    assert.equal(res.status, 200);
    assert.equal(res.body, 'EVENT_RECEIVED');
    await app.queue.onIdle();
    assert.equal(mock.callsTo(/graph\.facebook\.com/).length, 2);
    assert.equal(mock.callsTo(N8N).length, 2);
    assert.equal(mock.callsTo(/api\.telegram\.org/).length, 2);
    assert.equal((await store.get(leadId(1)))?.status, 'done');
  });

  test('a repeated notification is skipped', async () => {
    const before = mock.calls.length;
    assert.equal((await signed(port, webhookBody([leadId(1)]))).status, 200);
    await app.queue.onIdle();
    assert.equal(mock.calls.length, before);
  });

  test('signature failures', async () => {
    const raw = JSON.stringify(webhookBody([leadId(3)]));
    assert.equal((await http(port, 'POST', '/webhook', raw)).status, 401);
    assert.equal((await signed(port, webhookBody([leadId(3)]), 'wrong-secret')).status, 403);
    assert.equal((await http(port, 'POST', '/webhook', raw, { 'x-hub-signature-256': 'sha256=nothex' })).status, 403);
    await app.queue.onIdle();
    assert.equal(await store.get(leadId(3)), undefined);
  });

  test('signed but invalid JSON, and oversized bodies', async () => {
    const raw = '{not json';
    assert.equal((await http(port, 'POST', '/webhook', raw, { 'x-hub-signature-256': signPayload(raw, APP_SECRET) })).status, 400);
    const big = Buffer.alloc(2 * 1024 * 1024, 'a');
    const res = await http(port, 'POST', '/webhook', big, { 'x-hub-signature-256': signPayload(big, APP_SECRET) }).catch(() => ({ status: 413 }) as Res);
    assert.equal(res.status, 413);
  });

  test('notifications without leads are acknowledged', async () => {
    const res = await signed(port, { object: 'page', entry: [{ id: '1', time: 1, changes: [{ field: 'feed', value: {} }] }] });
    assert.equal(res.status, 200);
  });

  test('health, 404 and 405', async () => {
    const h = await http(port, 'GET', '/healthz');
    assert.deepEqual([h.status, JSON.parse(h.body)], [200, { status: 'ok' }]);
    assert.equal((await http(port, 'GET', '/nope')).status, 404);
    const m = await http(port, 'PUT', '/webhook', '');
    assert.equal(m.status, 405);
    assert.equal(m.headers.allow, 'GET, POST');
  });

  test('admin endpoints need the bearer token', async () => {
    assert.equal((await http(port, 'GET', '/admin/stats')).status, 401);
    assert.equal((await http(port, 'GET', '/admin/stats', undefined, { authorization: 'Bearer wrong' })).status, 401);
    const auth = { authorization: `Bearer ${ADMIN}` };
    const stats = await http(port, 'GET', '/admin/stats', undefined, auth);
    assert.equal(stats.status, 200);
    assert.equal(JSON.parse(stats.body).store.done, 2);
    const rec = await http(port, 'GET', `/admin/leads/${leadId(1)}`, undefined, auth);
    assert.equal(JSON.parse(rec.body).status, 'done');
    assert.equal((await http(port, 'GET', `/admin/leads/${leadId(99)}`, undefined, auth)).status, 404);
    // Replay without force is a duplicate; with force it is delivered again.
    const dup = await http(port, 'POST', `/admin/leads/${leadId(1)}/replay`, '', auth);
    assert.equal(JSON.parse(dup.body).status, 'duplicate');
    const n8nBefore = mock.callsTo(N8N).length;
    const forced = await http(port, 'POST', `/admin/leads/${leadId(1)}/replay?force=1`, '', auth);
    assert.equal(forced.status, 200);
    assert.equal(JSON.parse(forced.body).status, 'done');
    assert.equal(mock.callsTo(N8N).length, n8nBefore + 1);
    assert.equal((await http(port, 'DELETE', '/admin/stats', undefined, auth)).status, 404);
  });
});

describe('after-processing ack', () => {
  test('answers 500 when a sink fails so Meta retries, 200 when delivered', async () => {
    const mock = new MockFetch();
    mock.on('GET', /graph\.facebook\.com/, (call) => ({ json: lead(new URL(call.url).pathname.split('/').pop()!) }));
    mock.on('POST', N8N, { status: 400, text: 'rejected' }, { text: 'ok' });
    mock.on('POST', /api\.telegram\.org/, { json: { ok: true } });
    const app = await createApp(config({ server: { ackMode: 'after-processing' } }), { fetch: mock.fetch, logger: silentLogger, sleep: noSleep });
    const port = await app.listen();
    try {
      assert.equal((await signed(port, webhookBody([leadId(10)]))).status, 500);
      // Meta retries: only the failed sink is called again.
      assert.equal((await signed(port, webhookBody([leadId(10)]))).status, 200);
      assert.equal(mock.callsTo(/api\.telegram\.org/).length, 1);
      assert.equal(mock.callsTo(N8N).length, 2);
    } finally {
      await app.close();
    }
  });
});

describe('admin disabled and queue full', () => {
  test('admin routes 404 without a token; 503 when the queue is full', async () => {
    const mock = graphAndSinks(new MockFetch());
    const app = await createApp(
      parseConfig({ ...{ meta: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, accessToken: PAGE_TOKEN } }, store: { type: 'memory' }, logLevel: 'silent' }),
      { fetch: mock.fetch, logger: silentLogger },
    );
    const full = new WorkQueue<LeadgenEvent>(() => new Promise(() => {}), 1, () => {}, 0);
    const server = createHttpServer({
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      processor: app.processor,
      queue: full,
      store: app.store,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      assert.equal((await http(port, 'GET', '/admin/stats', undefined, { authorization: 'Bearer x' })).status, 404);
      assert.equal((await signed(port, webhookBody([leadId(20)]))).status, 503);
    } finally {
      await new Promise((r) => server.close(r));
      await app.store.close();
    }
  });
});

describe('retry sweep', () => {
  test('retryPending delivers what failed and prunes old records', async () => {
    const mock = new MockFetch();
    mock.on('GET', /graph\.facebook\.com/, (call) => ({ json: lead(new URL(call.url).pathname.split('/').pop()!) }));
    mock.on('POST', N8N, { status: 500, text: 'down' }, { status: 500, text: 'down' }, { status: 500, text: 'down' }, { text: 'ok' });
    mock.on('POST', /api\.telegram\.org/, { json: { ok: true } });
    let now = 1_800_000_000_000;
    const store = new MemoryStore();
    await store.put('1', { status: 'done', delivered: [], attempts: 1, firstSeenAt: 0, updatedAt: 0 });
    const app = await createApp(config(), { fetch: mock.fetch, store, logger: silentLogger, sleep: noSleep, now: () => now });
    const result = await app.processor.process({ leadgenId: leadId(30), pageId: '1' });
    assert.equal(result.status, 'partial');
    now += 1000;
    assert.equal(await app.retryPending(), 1);
    assert.equal((await store.get(leadId(30)))?.status, 'done');
    assert.equal(await store.get('1'), undefined, 'old record pruned');
    await app.close();
  });
});
