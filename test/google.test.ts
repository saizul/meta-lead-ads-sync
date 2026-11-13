import assert from 'node:assert/strict';
import { createVerify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SinkError } from '../src/errors.js';
import {
  GOOGLE_TOKEN_URL,
  GoogleServiceAccountAuth,
  SHEETS_SCOPE,
  createJwtAssertion,
  loadServiceAccount,
  parseServiceAccount,
} from '../src/google-auth.js';
import { FieldMapper } from '../src/mapping.js';
import { GoogleSheetsSink, escapeCell } from '../src/sinks/google-sheets.js';
import type { LeadContext } from '../src/types.js';
import { event, lead, leadId, serviceAccountJson, testPrivateKey } from './helpers/fixtures.js';
import { MockFetch, type RecordedCall } from './helpers/mock-fetch.js';

const { privateKey, publicKey } = testPrivateKey();
const KEY = parseServiceAccount(serviceAccountJson(privateKey));
const SHEET = 'sheet_ID-123';
const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values/`;

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('JWT assertion: RS256 header, claims and a valid signature', () => {
  const jwt = createJwtAssertion(KEY, [SHEETS_SCOPE, 'https://www.googleapis.com/auth/drive.file'], 1_700_000_000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(decode(h!), { alg: 'RS256', typ: 'JWT', kid: 'key-id-1' });
  assert.deepEqual(decode(c!), {
    iss: 'lead-sync@example-project.iam.gserviceaccount.com',
    scope: `${SHEETS_SCOPE} https://www.googleapis.com/auth/drive.file`,
    aud: GOOGLE_TOKEN_URL,
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'));
  assert.equal(ok, true);
});

test('JWT lifetime is capped at one hour and sub is optional', () => {
  const claims = decode(createJwtAssertion(KEY, [SHEETS_SCOPE], 100, 99_999, 'admin@example.com').split('.')[1]!);
  assert.equal(claims.exp, 3700);
  assert.equal(claims.sub, 'admin@example.com');
});

test('service account parsing', async () => {
  const escaped = JSON.stringify({ client_email: 'a@b', private_key: '-----BEGIN-----\\nabc\\n-----END-----' });
  assert.equal(parseServiceAccount(escaped).private_key, '-----BEGIN-----\nabc\n-----END-----');
  assert.throws(() => parseServiceAccount('nope'), /not valid JSON/);
  assert.throws(() => parseServiceAccount('{"type":"authorized_user"}'), /expected a service account/);
  assert.throws(() => parseServiceAccount('{"client_email":"a"}'), /client_email and private_key/);
  assert.throws(() => createJwtAssertion({ client_email: 'a', private_key: 'not a key' }, [], 0), /cannot sign/);
  const dir = await mkdtemp(join(tmpdir(), 'mlas-g-'));
  try {
    const file = join(dir, 'sa.json');
    await writeFile(file, serviceAccountJson(privateKey));
    assert.equal((await loadServiceAccount(file)).client_email, KEY.client_email);
    await assert.rejects(loadServiceAccount(join(dir, 'missing.json')), /cannot read service account key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function tokenRoute(mock: MockFetch, ...tokens: string[]) {
  mock.on(
    'POST',
    GOOGLE_TOKEN_URL,
    ...tokens.map((t) => (call: RecordedCall) => {
      const body = new URLSearchParams(call.body);
      assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(body.get('assertion')!.split('.').length, 3);
      assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
      return { json: { access_token: t, expires_in: 3599, token_type: 'Bearer' } };
    }),
  );
}

test('access tokens are cached, shared between callers and refreshed near expiry', async () => {
  const mock = new MockFetch();
  tokenRoute(mock, 'tok-1', 'tok-2');
  let now = 1_700_000_000_000;
  const auth = new GoogleServiceAccountAuth({ key: KEY, fetch: mock.fetch, now: () => now });
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual([a, b], ['tok-1', 'tok-1']);
  assert.equal(mock.calls.length, 1);
  now += 3_000_000;
  assert.equal(await auth.getAccessToken(), 'tok-1');
  now += 560_000; // within a minute of expiry
  assert.equal(await auth.getAccessToken(), 'tok-2');
  assert.equal(auth.email, KEY.client_email);
});

test('token errors', async () => {
  const mock = new MockFetch().on('POST', GOOGLE_TOKEN_URL, { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } });
  const auth = new GoogleServiceAccountAuth({ key: KEY, fetch: mock.fetch });
  await assert.rejects(auth.getAccessToken(), (e: Error & { retryable?: boolean }) => /invalid_grant - Invalid JWT Signature/.test(e.message) && e.retryable === false);
  const down = new MockFetch().on('POST', GOOGLE_TOKEN_URL, { status: 503, text: '' });
  await assert.rejects(new GoogleServiceAccountAuth({ key: KEY, fetch: down.fetch }).getAccessToken(), (e: Error & { retryable?: boolean }) => e.retryable === true);
  const net = new MockFetch().on('POST', GOOGLE_TOKEN_URL, new TypeError('fetch failed'));
  await assert.rejects(new GoogleServiceAccountAuth({ key: KEY, fetch: net.fetch }).getAccessToken(), /fetch failed/);
});

function ctx(overrides = {}): LeadContext {
  const id = leadId(3);
  const mapper = new FieldMapper({
    columns: [
      { name: 'Lead ID', from: 'lead.id' },
      { name: 'Name', from: 'field.full_name' },
      { name: 'Phone', from: 'field.phone_number', transform: ['phone_bd'] },
      { name: 'Note', from: 'field.note' },
    ],
    includeUnmapped: true,
  });
  const l = lead(id, overrides);
  return { event: event(id), lead: l, mapped: mapper.map(l, event(id)) };
}

function sheetsMock(firstRow: unknown[][] | undefined) {
  const mock = new MockFetch();
  tokenRoute(mock, 'tok-1');
  mock.on('GET', `${SHEETS}${encodeURIComponent('Leads!1:1')}`, { json: firstRow ? { values: firstRow } : { range: 'Leads!A1:Z1', majorDimension: 'ROWS' } });
  mock.on('POST', /:append\?/, { json: { spreadsheetId: SHEET, tableRange: 'Leads!A1:D1', updates: { updatedRows: 1 } } });
  return mock;
}

test('appends a header row to an empty sheet, then the lead', async () => {
  const mock = sheetsMock(undefined);
  const auth = new GoogleServiceAccountAuth({ key: KEY, fetch: mock.fetch });
  const sink = new GoogleSheetsSink({ spreadsheetId: SHEET, range: 'Leads!A1', auth, fetch: mock.fetch, extraColumn: true });
  await sink.send(ctx());
  const appends = mock.callsTo(/:append\?/);
  assert.equal(appends.length, 2);
  const url = new URL(appends[1]!.url);
  assert.equal(url.pathname, `/v4/spreadsheets/${SHEET}/values/Leads!A1:append`);
  assert.equal(url.searchParams.get('valueInputOption'), 'RAW');
  assert.equal(url.searchParams.get('insertDataOption'), 'INSERT_ROWS');
  assert.equal(appends[1]!.headers.authorization, 'Bearer tok-1');
  assert.deepEqual(JSON.parse(appends[0]!.body).values, [['Lead ID', 'Name', 'Phone', 'Note', 'extra']]);
  const body = JSON.parse(appends[1]!.body);
  assert.equal(body.majorDimension, 'ROWS');
  assert.equal(body.range, 'Leads!A1');
  assert.deepEqual(body.values, [[leadId(3), 'Rahim Uddin', '+8801712345678', '', '{"email":" Rahim@Example.COM ","which_service?":"SEO, Meta ads"}']]);
  // The header check runs once per process.
  await sink.send(ctx());
  assert.equal(mock.callsTo(/values\/Leads!1%3A1|Leads%211%3A1/).length, 1);
  assert.equal(mock.callsTo(/:append\?/).length, 3);
});

test('existing header is left alone; explicit columns and USER_ENTERED escaping', async () => {
  const mock = sheetsMock([['Lead ID', 'Name']]);
  const auth = new GoogleServiceAccountAuth({ key: KEY, fetch: mock.fetch });
  const sink = new GoogleSheetsSink({
    spreadsheetId: SHEET,
    range: 'Leads!A1',
    auth,
    fetch: mock.fetch,
    columns: ['Name', 'Phone'],
    valueInputOption: 'USER_ENTERED',
  });
  await sink.send(ctx({ field_data: [{ name: 'full_name', values: ['=HYPERLINK("http://evil")'] }, { name: 'phone_number', values: ['01812345678'] }] }));
  const appends = mock.callsTo(/:append\?/);
  assert.equal(appends.length, 1);
  assert.equal(new URL(appends[0]!.url).searchParams.get('valueInputOption'), 'USER_ENTERED');
  assert.deepEqual(JSON.parse(appends[0]!.body).values, [["'=HYPERLINK(\"http://evil\")", "'+8801812345678"]]);
});

test('headerRow false skips the check', async () => {
  const mock = sheetsMock(undefined);
  const sink = new GoogleSheetsSink({ spreadsheetId: SHEET, auth: new GoogleServiceAccountAuth({ key: KEY, fetch: mock.fetch }), fetch: mock.fetch, headerRow: false });
  await sink.send(ctx());
  assert.equal(mock.calls.filter((c) => c.method === 'GET').length, 0);
  assert.match(mock.callsTo(/:append/)[0]!.url, /values\/Sheet1!A1:append/);
});

test('sheet errors: 401 refreshes the token and is retryable, 403 is not', async () => {
  const mock = new MockFetch();
  tokenRoute(mock, 'tok-1', 'tok-2');
  mock.on('POST', /:append\?/, { status: 401, json: { error: { code: 401, message: 'Request had invalid authentication credentials.' } } }, { status: 403, json: { error: { code: 403, message: 'The caller does not have permission' } } });
  const auth = new GoogleServiceAccountAuth({ key: KEY, fetch: mock.fetch });
  const sink = new GoogleSheetsSink({ spreadsheetId: SHEET, auth, fetch: mock.fetch, headerRow: false });
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && e.retryable && e.status === 401);
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && !e.retryable && /does not have permission/.test(e.message));
  assert.deepEqual(mock.callsTo(/:append/).map((c) => c.headers.authorization), ['Bearer tok-1', 'Bearer tok-2']);
});

test('token failure surfaces as a SinkError', async () => {
  const mock = new MockFetch().on('POST', GOOGLE_TOKEN_URL, { status: 500, text: '' });
  const sink = new GoogleSheetsSink({ spreadsheetId: SHEET, auth: new GoogleServiceAccountAuth({ key: KEY, fetch: mock.fetch }), fetch: mock.fetch });
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && e.retryable);
});

test('invalid spreadsheet id and escapeCell', () => {
  const auth = new GoogleServiceAccountAuth({ key: KEY });
  assert.throws(() => new GoogleSheetsSink({ spreadsheetId: '../x', auth }), /invalid spreadsheetId/);
  assert.equal(escapeCell('=1+1'), "'=1+1");
  assert.equal(escapeCell('@me'), "'@me");
  assert.equal(escapeCell('-5'), "'-5");
  assert.equal(escapeCell('hello'), 'hello');
});
