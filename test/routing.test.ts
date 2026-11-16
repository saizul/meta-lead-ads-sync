import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run, type CliIo } from '../src/cli.js';
import { parseConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { FieldMapper } from '../src/mapping.js';
import { LeadProcessor } from '../src/processor.js';
import { SinkRoute, type RouteSpec } from '../src/routing.js';
import type { Sink } from '../src/sinks/types.js';
import { MemoryStore } from '../src/store/memory.js';
import type { Lead, LeadContext } from '../src/types.js';
import { FORM_ID, PAGE_ID, event, lead, leadId } from './helpers/fixtures.js';
import { noSleep } from './helpers/mock-fetch.js';

const mapper = new FieldMapper({
  columns: [
    { name: 'Name', from: 'field.full_name' },
    { name: 'Phone', from: 'field.phone_number', transform: ['phone_bd'] },
    { name: 'City', from: 'field.city', default: 'unknown' },
  ],
});

function ctx(overrides: Partial<Lead> = {}, eventOverrides = {}): LeadContext {
  const l = lead(leadId(1), overrides);
  const e = event(leadId(1), eventOverrides);
  return { lead: l, event: e, mapped: mapper.map(l, e) };
}

const withCity = (city: string) => ({ field_data: [...lead('x').field_data!, { name: 'city', values: [city] }] });

test('forms and pages', () => {
  const r = new SinkRoute({ forms: [FORM_ID], pages: [PAGE_ID] });
  assert.equal(r.matches(ctx()), true);
  assert.match(r.evaluate(ctx({ form_id: '1' })).reason, /form 1 is not in forms/);
  assert.match(r.evaluate(ctx({}, { pageId: '2' })).reason, /page 2/);
  // Form id from the webhook when the Graph response has none.
  assert.equal(r.matches(ctx({ form_id: undefined })), true);
  assert.equal(new SinkRoute({ forms: `${FORM_ID}, 5` }).matches(ctx()), true);
});

test('organic and platform', () => {
  const ads = new SinkRoute({ organic: false, platforms: ['fb'] });
  assert.equal(ads.matches(ctx({ is_organic: false, platform: 'FB' })), true);
  assert.match(ads.evaluate(ctx({ is_organic: true, platform: 'fb' })).reason, /organic/);
  assert.match(ads.evaluate(ctx({ platform: 'fb' })).reason, /is_organic is missing/);
  assert.match(ads.evaluate(ctx({ is_organic: false, platform: 'ig' })).reason, /platform ig/);
});

test('all, any and none conditions', () => {
  const spec: RouteSpec = {
    all: [{ from: 'column.City', equals: ['Dhaka', 'Gazipur'] }],
    any: [
      { from: 'field.which_service?', matches: '\\bseo\\b' },
      { from: 'field.company', exists: true },
    ],
    none: [{ from: 'field.email', matches: '@test\\.' }],
  };
  const r = new SinkRoute(spec);
  assert.equal(r.matches(ctx(withCity(' dhaka '))), true, 'case and spaces are ignored');
  assert.match(r.evaluate(ctx(withCity('Sylhet'))).reason, /all: column.City equals dhaka\|gazipur failed/);
  assert.match(r.evaluate(ctx()).reason, /all:/, 'City defaults to "unknown"');

  const noService = { field_data: [{ name: 'city', values: ['Dhaka'] }, { name: 'email', values: ['a@b.com'] }] };
  assert.match(r.evaluate(ctx(noService)).reason, /^any: none of/);

  const testLead = {
    field_data: [
      { name: 'city', values: ['Dhaka'] },
      { name: 'which_service?', values: ['SEO'] },
      { name: 'email', values: ['x@test.org'] },
    ],
  };
  assert.match(r.evaluate(ctx(testLead)).reason, /none: field.email matches/);
});

test('notEquals, exists false, lead and event sources', () => {
  assert.equal(new SinkRoute({ all: [{ from: 'field.company', exists: false }] }).matches(ctx()), true);
  assert.equal(new SinkRoute({ all: [{ from: 'lead.ad_id', notEquals: '1' }] }).matches(ctx()), true);
  assert.equal(new SinkRoute({ all: [{ from: 'lead.ad_id', notEquals: ['333333333333333'] }] }).matches(ctx()), false);
  assert.equal(new SinkRoute({ all: [{ from: 'event.created_time', equals: '1763000000' }] }).matches(ctx()), true);
  assert.equal(new SinkRoute({ all: [{ from: 'column.Phone', matches: '^\\+88017' }] }).matches(ctx()), true);
  // Two tests in one condition must both hold.
  assert.equal(new SinkRoute({ all: [{ from: 'field.full_name', exists: true, matches: '^karim' }] }).matches(ctx()), false);
});

test('invalid rules are rejected', () => {
  const bad: unknown[] = [
    {},
    [],
    { forms: [] },
    { forms: ['abc'] },
    { organic: 'yes' },
    { colour: 'red' },
    { all: [] },
    { all: [{ from: 'field.city' }] },
    { all: [{ from: 'city', equals: 'x' }] },
    { all: [{ from: 'event.nope', equals: 'x' }] },
    { all: [{ from: 'field.city', matches: '(' }] },
    { all: [{ from: 'field.city', equals: [] }] },
    { all: [{ from: 'field.city', exists: 'yes' }] },
    { all: [{ from: 'field.city', equals: 'x', typo: 1 }] },
  ];
  for (const spec of bad) assert.throws(() => new SinkRoute(spec as RouteSpec), ConfigError, JSON.stringify(spec));
});

test('config validates and keeps sink rules', () => {
  const base = { meta: { appSecret: 's', verifyToken: 'verify-token', accessToken: 'EAAtoken' } };
  const c = parseConfig({
    ...base,
    sinks: [{ type: 'webhook', name: 'crm', url: 'https://crm.example.com/hook', when: { organic: false } }],
  });
  assert.deepEqual(c.sinks[0]!.when, { organic: false });
  assert.throws(
    () => parseConfig({ ...base, sinks: [{ type: 'webhook', url: 'https://x.example.com', when: { all: [{ from: 'x' }] } }] }),
    /sinks\[0\]\.when\.all\[0\]/,
  );
});

class FakeSink implements Sink {
  readonly type = 'fake';
  readonly received: string[] = [];
  fail = 0;
  constructor(readonly name: string) {}
  async send(c: LeadContext): Promise<void> {
    if (this.fail-- > 0) throw new Error('down');
    this.received.push(c.lead.id);
  }
}

function processorWith(sinks: FakeSink[], routes: Record<string, SinkRoute>, leads: Record<string, Lead> = {}) {
  const store = new MemoryStore();
  let now = 1_000_000;
  const processor = new LeadProcessor({
    graph: { getLead: async (id: string) => leads[id] ?? lead(id) },
    store,
    sinks,
    mapper,
    routes,
    sinkRetry: { attempts: 1, sleep: noSleep },
    now: () => (now += 1000),
  });
  return { processor, store };
}

test('processor delivers only to matching sinks and counts the lead as done', async () => {
  const sheet = new FakeSink('sheet');
  const dhaka = new FakeSink('dhaka-team');
  const { processor, store } = processorWith([sheet, dhaka], {
    'dhaka-team': new SinkRoute({ all: [{ from: 'column.City', equals: 'Dhaka' }] }),
  }, { [leadId(2)]: lead(leadId(2), withCity('Dhaka')) });

  const r1 = await processor.process(event(leadId(1)));
  assert.equal(r1.status, 'done');
  assert.deepEqual(r1.delivered, ['sheet']);
  assert.equal(r1.routedAway?.[0]?.sink, 'dhaka-team');
  assert.match(r1.routedAway![0]!.reason, /column.City/);
  assert.equal((await store.get(leadId(1)))?.status, 'done');

  const r2 = await processor.process(event(leadId(2)));
  assert.deepEqual(r2.delivered, ['sheet', 'dhaka-team']);
  assert.equal(r2.routedAway, undefined);
  assert.deepEqual(dhaka.received, [leadId(2)]);
});

test('a lead routed away from every sink is done, not failed', async () => {
  const only = new FakeSink('only');
  const { processor } = processorWith([only], { only: new SinkRoute({ forms: ['1'] }) });
  const r = await processor.process(event(leadId(3)));
  assert.equal(r.status, 'done');
  assert.deepEqual(r.delivered, []);
  assert.equal(only.received.length, 0);
});

test('retries only resend to matching sinks that failed', async () => {
  const sheet = new FakeSink('sheet');
  const crm = new FakeSink('crm');
  const tg = new FakeSink('telegram');
  crm.fail = 1;
  const { processor } = processorWith([sheet, crm, tg], {
    crm: new SinkRoute({ forms: [FORM_ID] }),
    telegram: new SinkRoute({ forms: ['1'] }),
  });
  const first = await processor.process(event(leadId(4)));
  assert.equal(first.status, 'partial');
  const [again] = await processor.retryPending({ maxAttempts: 5 });
  assert.equal(again!.status, 'done');
  assert.deepEqual(sheet.received, [leadId(4)]);
  assert.deepEqual(crm.received, [leadId(4)]);
  assert.deepEqual(tg.received, []);
});

test('cli route explains decisions offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mlas-route-'));
  try {
    const configPath = join(dir, 'config.json');
    const leadPath = join(dir, 'lead.json');
    await writeFile(
      configPath,
      JSON.stringify({
        meta: { appSecret: 's', verifyToken: 'verify-token', accessToken: 'EAAtoken' },
        store: { type: 'memory' },
        mapping: { columns: [{ name: 'City', from: 'field.city' }] },
        sinks: [
          { type: 'webhook', name: 'all-leads', url: 'https://a.example.com/hook' },
          { type: 'webhook', name: 'dhaka', url: 'https://b.example.com/hook', when: { all: [{ from: 'column.City', equals: 'Dhaka' }] } },
          { type: 'webhook', name: 'ctg', url: 'https://c.example.com/hook', when: { all: [{ from: 'column.City', equals: 'Chattogram' }] } },
          { type: 'webhook', name: 'off', enabled: false, url: 'https://d.example.com/hook' },
        ],
      }),
    );
    await writeFile(leadPath, JSON.stringify(lead(leadId(5), withCity('Dhaka'))));
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), env: {} };
    assert.equal(await run(['route', leadPath, '--config', configPath, '--page-id', PAGE_ID], io), 0);
    assert.deepEqual(out.slice(0, 4), ['all-leads\tdeliver', 'dhaka\tdeliver', `ctg\tskip\tall: column.City equals chattogram failed`, 'off\tdisabled']);
    assert.equal(out[4], `2 sink(s) would get lead ${leadId(5)}`);

    assert.equal(await run(['route', '--config', configPath], io), 2);
    await writeFile(leadPath, '{"not":"a lead"}');
    assert.equal(await run(['route', leadPath, '--config', configPath], io), 2);
    assert.match(err.at(-1)!, /needs at least an "id"/);

    out.length = 0;
    assert.equal(await run(['check-config', '--config', configPath], io), 0);
    assert.ok(out.some((l) => /dhaka \[webhook\] \(routed\)/.test(l)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
