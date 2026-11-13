import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleVerification, parseLeadgenEvents } from '../src/webhook.js';
import { FORM_ID, PAGE_ID, leadId, webhookBody } from './helpers/fixtures.js';

const q = (o: Record<string, string>) => new URLSearchParams(o);

test('verification answers the challenge when the token matches', () => {
  const r = handleVerification(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok-12345', 'hub.challenge': '1158201444' }), 'tok-12345');
  assert.deepEqual(r, { ok: true, challenge: '1158201444' });
});

test('verification failures', () => {
  assert.equal(handleVerification(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '1' }), 'tok').ok, false);
  const wrong = handleVerification(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '1' }), 'tok');
  assert.equal(!wrong.ok && wrong.status, 403);
  const missing = handleVerification(q({ 'hub.mode': 'subscribe' }), 'tok');
  assert.equal(!missing.ok && missing.status, 400);
  const mode = handleVerification(q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1' }), 'tok');
  assert.equal(!mode.ok && mode.status, 400);
  const xss = handleVerification(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '<script>' }), 'tok');
  assert.equal(!xss.ok && xss.status, 400);
  const noToken = handleVerification(q({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }), '');
  assert.equal(noToken.ok, false);
});

test('parses leadgen changes', () => {
  const r = parseLeadgenEvents(webhookBody([leadId(1), leadId(2)]));
  assert.equal(r.object, 'page');
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.events[0], {
    leadgenId: leadId(1),
    pageId: PAGE_ID,
    formId: FORM_ID,
    adId: '333333333333333',
    adgroupId: '333333333333333',
    createdTime: 1763000000,
    entryTime: 1763000000,
  });
});

test('ignores other fields and malformed changes, dedupes ids', () => {
  const body = webhookBody(
    [leadId(1), leadId(1)],
    [
      { field: 'feed', value: { item: 'post' } },
      { field: 'leadgen', value: { page_id: PAGE_ID } },
      { field: 'leadgen' },
      null,
    ],
  );
  const r = parseLeadgenEvents(body);
  assert.equal(r.events.length, 1);
  assert.equal(r.ignored, 4);
});

test('numeric ids and missing page_id fall back to the entry id', () => {
  const r = parseLeadgenEvents({
    object: 'page',
    entry: [{ id: 12345, time: '1763000000', changes: [{ field: 'leadgen', value: { leadgen_id: 987654321 } }] }],
  });
  assert.deepEqual(r.events, [{ leadgenId: '987654321', pageId: '12345', entryTime: 1763000000 }]);
});

test('several entries in one notification', () => {
  const a = webhookBody([leadId(1)]) as { entry: object[] };
  const b = webhookBody([leadId(2)]) as { entry: object[] };
  const r = parseLeadgenEvents({ object: 'page', entry: [...a.entry, ...b.entry] });
  assert.deepEqual(r.events.map((e) => e.leadgenId), [leadId(1), leadId(2)]);
});

test('garbage input', () => {
  for (const input of [null, undefined, 'x', 42, [], {}, { entry: 'x' }, { entry: [1, { changes: 'x' }] }]) {
    assert.equal(parseLeadgenEvents(input).events.length, 0);
  }
});
