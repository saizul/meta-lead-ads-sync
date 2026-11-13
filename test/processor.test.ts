import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphApiError, SinkError } from '../src/errors.js';
import { FieldMapper } from '../src/mapping.js';
import { LeadProcessor } from '../src/processor.js';
import type { Sink } from '../src/sinks/types.js';
import { MemoryStore } from '../src/store/memory.js';
import type { Lead, LeadContext } from '../src/types.js';
import { FORM_ID, PAGE_ID, event, lead, leadId } from './helpers/fixtures.js';
import { noSleep } from './helpers/mock-fetch.js';

class FakeSink implements Sink {
  readonly type = 'fake';
  readonly received: LeadContext[] = [];
  failures: Array<SinkError | Error> = [];
  constructor(readonly name: string) {}
  async send(ctx: LeadContext): Promise<void> {
    const f = this.failures.shift();
    if (f) throw f;
    this.received.push(ctx);
  }
}

function setup(options: { leads?: Record<string, Lead | Error>; sinks?: FakeSink[]; now?: () => number; extra?: object } = {}) {
  const store = new MemoryStore();
  const sinks = options.sinks ?? [new FakeSink('sheet'), new FakeSink('telegram')];
  const fetched: string[] = [];
  const graph = {
    getLead: async (id: string) => {
      fetched.push(id);
      const l = options.leads?.[id] ?? lead(id);
      if (l instanceof Error) throw l;
      return l;
    },
  };
  const processor = new LeadProcessor({
    graph,
    store,
    sinks,
    mapper: new FieldMapper(),
    sinkRetry: { attempts: 2, sleep: noSleep },
    ...(options.now ? { now: options.now } : {}),
    ...options.extra,
  });
  return { processor, store, sinks, fetched };
}

test('processes a new lead into every sink and records it', async () => {
  const { processor, store, sinks } = setup();
  const r = await processor.process(event(leadId(1)));
  assert.equal(r.status, 'done');
  assert.deepEqual(r.delivered, ['sheet', 'telegram']);
  assert.equal(sinks[0]!.received[0]!.mapped.values.phone_number, '+8801712345678');
  const rec = await store.get(leadId(1));
  assert.equal(rec?.status, 'done');
  assert.equal(rec?.formId, FORM_ID);
  assert.equal(rec?.pageId, PAGE_ID);
  assert.equal(rec?.lastError, undefined);
});

test('duplicates are skipped without calling the Graph API', async () => {
  const { processor, fetched, sinks } = setup();
  await processor.process(event(leadId(2)));
  const again = await processor.process(event(leadId(2)));
  assert.equal(again.status, 'duplicate');
  assert.deepEqual(fetched, [leadId(2)]);
  assert.equal(sinks[0]!.received.length, 1);
});

test('concurrent duplicates: only one is processed', async () => {
  const { processor, fetched } = setup();
  const results = await Promise.all([processor.process(event(leadId(3))), processor.process(event(leadId(3)))]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['done', 'in-progress']);
  assert.equal(fetched.length, 1);
});

test('sink retries transient errors', async () => {
  const sheet = new FakeSink('sheet');
  sheet.failures = [new SinkError('sheet', 'HTTP 503', { retryable: true })];
  const { processor } = setup({ sinks: [sheet] });
  const r = await processor.process(event(leadId(4)));
  assert.equal(r.status, 'done');
  assert.equal(sheet.received.length, 1);
});

test('partial delivery: a retry only resends to the failed sink', async () => {
  const sheet = new FakeSink('sheet');
  const tg = new FakeSink('telegram');
  tg.failures = [new SinkError('telegram', 'chat not found')]; // not retryable: one failure per attempt
  let now = 1_000_000;
  const { processor, store } = setup({ sinks: [sheet, tg], now: () => now });
  const first = await processor.process(event(leadId(5)));
  assert.equal(first.status, 'partial');
  assert.deepEqual(first.delivered, ['sheet']);
  assert.equal(first.errors[0]!.sink, 'telegram');
  assert.match((await store.get(leadId(5)))!.lastError!, /chat not found/);

  now += 1000;
  const retried = await processor.retryPending({ maxAttempts: 5 });
  assert.equal(retried.length, 1);
  assert.equal(retried[0]!.status, 'done');
  assert.equal(sheet.received.length, 1, 'sheet must not get a second row');
  assert.equal(tg.received.length, 1);
  const rec = await store.get(leadId(5));
  assert.equal(rec?.attempts, 2);
  assert.equal(rec?.lastError, undefined);
});

test('every sink failing marks the lead failed', async () => {
  const sheet = new FakeSink('sheet');
  sheet.failures = [new Error('boom')];
  const { processor } = setup({ sinks: [sheet] });
  const r = await processor.process(event(leadId(6)));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.delivered, []);
});

test('graph failures mark the lead failed and are retried later', async () => {
  const leads: Record<string, Lead | Error> = { [leadId(7)]: new GraphApiError('Graph API error 190: token expired', { status: 400, code: 190, retryable: false }) };
  const { processor, store } = setup({ leads });
  const r = await processor.process(event(leadId(7)));
  assert.equal(r.status, 'failed');
  assert.equal(r.errors[0]!.sink, 'graph');
  assert.match((await store.get(leadId(7)))!.lastError!, /token expired/);
  delete leads[leadId(7)];
  const [retry] = await processor.retryPending({ maxAttempts: 3 });
  assert.equal(retry!.status, 'done');
});

test('retryPending respects maxAttempts', async () => {
  const sheet = new FakeSink('sheet');
  sheet.failures = Array.from({ length: 20 }, () => new Error('down'));
  const { processor } = setup({ sinks: [sheet] });
  await processor.process(event(leadId(8)));
  assert.equal((await processor.retryPending({ maxAttempts: 2 })).length, 1);
  assert.equal((await processor.retryPending({ maxAttempts: 2 })).length, 0);
});

test('page and form filters', async () => {
  const { processor, fetched } = setup({ extra: { pageIds: [PAGE_ID], formIds: ['999'] } });
  assert.equal((await processor.process(event(leadId(9)))).status, 'skipped');
  assert.equal((await processor.process(event(leadId(9), { pageId: '1' }))).status, 'skipped');
  assert.equal((await processor.process(event(leadId(9), { formId: '999' }))).status, 'done');
  assert.equal((await processor.process(event(leadId(10), { formId: undefined }))).status, 'skipped');
  assert.deepEqual(fetched, [leadId(9)]);
});

test('per-form mappings', async () => {
  const sheet = new FakeSink('sheet');
  const { processor } = setup({
    sinks: [sheet],
    extra: { formMappers: { [FORM_ID]: new FieldMapper({ columns: [{ name: 'Mobile', from: 'field.phone_number', transform: ['phone_bd:national'] }] }) } },
  });
  await processor.process(event(leadId(11)));
  assert.deepEqual(sheet.received[0]!.mapped.values, { Mobile: '01712345678' });
});

test('no sinks still records the lead as done', async () => {
  const { processor, store } = setup({ sinks: [] });
  assert.equal((await processor.process(event(leadId(12)))).status, 'done');
  assert.equal((await store.get(leadId(12)))?.status, 'done');
});
