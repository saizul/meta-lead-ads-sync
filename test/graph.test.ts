import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphApiError } from '../src/errors.js';
import { DEFAULT_LEAD_FIELDS, GraphClient, isRetryableGraphCode } from '../src/graph.js';
import { appSecretProof } from '../src/signature.js';
import { APP_SECRET, PAGE_TOKEN, lead, leadId } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

const ID = leadId(7);
const URL_PREFIX = `https://graph.facebook.com/v27.0/${ID}`;

function client(mock: MockFetch, extra: Partial<ConstructorParameters<typeof GraphClient>[0]> = {}) {
  return new GraphClient({ accessToken: PAGE_TOKEN, appSecret: APP_SECRET, fetch: mock.fetch, retry: { sleep: noSleep }, ...extra });
}

test('fetches a lead with fields, appsecret_proof and a bearer token', async () => {
  const mock = new MockFetch().on('GET', URL_PREFIX, { json: lead(ID) });
  const result = await client(mock).getLead(ID);
  assert.equal(result.id, ID);
  const call = mock.calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.searchParams.get('fields'), DEFAULT_LEAD_FIELDS.join(','));
  assert.equal(url.searchParams.get('appsecret_proof'), appSecretProof(PAGE_TOKEN, APP_SECRET));
  assert.equal(url.searchParams.get('access_token'), null, 'token must not be in the URL');
  assert.equal(call.headers.authorization, `Bearer ${PAGE_TOKEN}`);
});

test('custom fields, version and no proof', async () => {
  const mock = new MockFetch().on('GET', `https://graph.facebook.com/v26.0/${ID}`, { json: lead(ID) });
  await client(mock, { version: 'v26.0', fields: ['id', 'field_data', 'campaign_name'], appSecret: undefined }).getLead(ID);
  const url = new URL(mock.calls[0]!.url);
  assert.equal(url.searchParams.get('fields'), 'id,field_data,campaign_name');
  assert.equal(url.searchParams.has('appsecret_proof'), false);
});

test('per-page tokens', async () => {
  const mock = new MockFetch().on('GET', URL_PREFIX, { json: lead(ID) });
  const c = client(mock, { accessToken: (page) => (page === '42' ? 'page-42-token' : undefined) });
  await c.getLead(ID, '42');
  assert.equal(mock.calls[0]!.headers.authorization, 'Bearer page-42-token');
  await assert.rejects(c.getLead(ID, '43'), /no access token for page 43/);
});

test('retries rate limits, transient errors, 5xx and network failures', async () => {
  const mock = new MockFetch().on(
    'GET',
    URL_PREFIX,
    { status: 400, json: { error: { message: 'Application request limit reached', code: 4, type: 'OAuthException' } } },
    { status: 500, json: { error: { message: 'An unexpected error has occurred.', code: 2, is_transient: true } } },
    new TypeError('fetch failed'),
    { json: lead(ID) },
  );
  const result = await client(mock, { retry: { sleep: noSleep, attempts: 5 } }).getLead(ID);
  assert.equal(result.id, ID);
  assert.equal(mock.calls.length, 4);
});

test('does not retry permission and token errors', async () => {
  const mock = new MockFetch().on('GET', URL_PREFIX, {
    status: 400,
    json: { error: { message: 'Error validating access token', code: 190, error_subcode: 463, type: 'OAuthException', fbtrace_id: 'AbC' } },
  });
  await assert.rejects(client(mock).getLead(ID), (e: unknown) => {
    assert.ok(e instanceof GraphApiError);
    assert.equal(e.code, 190);
    assert.equal(e.subcode, 463);
    assert.equal(e.fbtraceId, 'AbC');
    assert.equal(e.retryable, false);
    return true;
  });
  assert.equal(mock.calls.length, 1);
});

test('invalid JSON and missing id', async () => {
  const bad = new MockFetch().on('GET', URL_PREFIX, { status: 200, text: '<html>' });
  await assert.rejects(client(bad).getLead(ID), /invalid JSON/);
  const noId = new MockFetch().on('GET', URL_PREFIX, { json: { field_data: [] } });
  await assert.rejects(client(noId).getLead(ID), /no lead id/);
  const proxy = new MockFetch().on('GET', URL_PREFIX, { status: 502, text: 'Bad Gateway' });
  await assert.rejects(client(proxy, { retry: { sleep: noSleep, attempts: 2 } }).getLead(ID), (e: unknown) => e instanceof GraphApiError && e.retryable);
  assert.equal(proxy.calls.length, 2);
});

test('rejects non-numeric lead ids and bad versions', async () => {
  const mock = new MockFetch();
  await assert.rejects(client(mock).getLead('../me'), /invalid leadgen id/);
  assert.equal(mock.calls.length, 0);
  assert.throws(() => client(mock, { version: '27' }), /invalid Graph API version/);
});

test('retryable code table', () => {
  for (const c of [1, 2, 4, 17, 32, 341, 613, 80000, 80014]) assert.equal(isRetryableGraphCode(c), true, String(c));
  for (const c of [undefined, 10, 100, 190, 200, 80015]) assert.equal(isRetryableGraphCode(c), false, String(c));
});
