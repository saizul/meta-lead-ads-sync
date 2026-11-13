import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseConfig, substituteEnv } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const minimal = () => ({
  meta: { appSecret: 'secret', verifyToken: 'verify-token', accessToken: 'EAAtoken' },
});

test('defaults', () => {
  const c = parseConfig(minimal());
  assert.equal(c.server.port, 8080);
  assert.equal(c.server.host, '0.0.0.0');
  assert.equal(c.server.webhookPath, '/webhook');
  assert.equal(c.server.ackMode, 'immediate');
  assert.equal(c.server.adminToken, undefined);
  assert.equal(c.meta.graphVersion, 'v27.0');
  assert.equal(c.meta.appSecretProof, true);
  assert.equal(c.store.type, 'json');
  assert.equal(c.store.retentionDays, 90);
  assert.equal(c.processing.concurrency, 2);
  assert.equal(c.processing.maxAttempts, 8);
  assert.equal(c.logLevel, 'info');
  assert.deepEqual(c.sinks, []);
  assert.ok(c.mapping.columns.length > 0);
});

test('full config with every sink type', () => {
  const c = parseConfig({
    server: { port: '3000', webhookPath: '/meta/leads', ackMode: 'after-processing', adminToken: 'a'.repeat(32) },
    meta: {
      ...minimal().meta,
      pageTokens: { '123': 'EAApage' },
      fields: 'id,created_time,field_data,campaign_name',
      pageIds: ['123'],
      appSecretProof: 'false',
      graphVersion: 'v26.0',
    },
    store: { type: 'sqlite', path: '/data/leads.sqlite', retentionDays: 30 },
    sinks: [
      { type: 'google_sheets', spreadsheetId: 'abc', range: 'Leads!A1', credentialsFile: '/run/secrets/sa.json', columns: ['a', 'b'] },
      { type: 'webhook', name: 'n8n', url: 'https://n8n.example.com/webhook/x', secret: 's', headers: { 'X-Key': 'k' }, timeoutMs: 5000 },
      { type: 'telegram', botToken: '1:abc', chatId: -100123, template: '{{#all}}', messageThreadId: 4 },
      { type: 'webhook', name: 'off', url: 'https://example.com', enabled: false },
    ],
    formMappings: { '555': { columns: [{ name: 'x', from: 'lead.id' }] } },
    logLevel: 'debug',
  });
  assert.equal(c.server.port, 3000);
  assert.equal(c.server.ackMode, 'after-processing');
  assert.deepEqual(c.meta.fields, ['id', 'created_time', 'field_data', 'campaign_name']);
  assert.equal(c.meta.appSecretProof, false);
  assert.equal(c.store.path, '/data/leads.sqlite');
  assert.equal(c.sinks.length, 4);
  assert.equal(c.sinks[2]!.type === 'telegram' && c.sinks[2]!.chatId, '-100123');
  assert.equal(c.sinks[3]!.enabled, false);
  assert.ok(c.formMappings['555']);
});

test('validation errors', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{}, /meta.appSecret is required/],
    [{ meta: { appSecret: 's', verifyToken: 'verify-token' } }, /accessToken or meta.pageTokens/],
    [{ meta: { appSecret: 's', verifyToken: 'short', accessToken: 't' } }, /at least 8/],
    [{ ...minimal(), server: { port: 70000 } }, /server.port/],
    [{ ...minimal(), server: { webhookPath: 'webhook' } }, /must start with/],
    [{ ...minimal(), server: { ackMode: 'later' } }, /ackMode/],
    [{ ...minimal(), server: { adminToken: 'short' } }, /adminToken/],
    [{ meta: { ...minimal().meta, graphVersion: '27' } }, /graphVersion/],
    [{ meta: { ...minimal().meta, pageTokens: { abc: 'x' } } }, /not a Page id/],
    [{ ...minimal(), store: { type: 'redis' } }, /store.type/],
    [{ ...minimal(), sinks: {} }, /sinks must be an array/],
    [{ ...minimal(), sinks: [{ type: 'email' }] }, /sinks\[0\].type/],
    [{ ...minimal(), sinks: [{ type: 'google_sheets', spreadsheetId: 'x' }] }, /credentialsFile or credentialsJson/],
    [{ ...minimal(), sinks: [{ type: 'webhook', url: 'ftp://x' }] }, /http\(s\) URL/],
    [{ ...minimal(), sinks: [{ type: 'telegram', botToken: '1:a' }] }, /chatId is required/],
    [{ ...minimal(), sinks: [{ type: 'webhook', url: 'https://a' }, { type: 'webhook', url: 'https://b' }] }, /unique "name"/],
    [{ ...minimal(), mapping: { columns: [{ name: 'a' }] } }, /needs "from" or "value"/],
    [{ ...minimal(), formMappings: { '1': { columns: 'x' } } }, /formMappings.1/],
    [{ ...minimal(), processing: { concurrency: 0 } }, /processing.concurrency/],
    [{ ...minimal(), logLevel: 'loud' }, /logLevel/],
    [{ ...minimal(), meta: 'x' }, /meta must be an object/],
  ];
  for (const [input, re] of cases) {
    assert.throws(() => parseConfig(input), (e: unknown) => e instanceof ConfigError && re.test((e as Error).message), String(re));
  }
});

test('environment substitution', () => {
  const env = { SECRET: 's3cret', EMPTY: '' };
  assert.deepEqual(substituteEnv({ a: '${SECRET}', b: ['x-${SECRET}'], c: '${MISSING:-fallback}', d: '${EMPTY:-def}', n: 5 }, env), {
    a: 's3cret',
    b: ['x-s3cret'],
    c: 'fallback',
    d: 'def',
    n: 5,
  });
  assert.throws(() => substituteEnv({ meta: { appSecret: '${NOPE}' } }, {}), /\$\.meta\.appSecret: environment variable NOPE is not set/);
});

test('loadConfig reads, substitutes and honours PORT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mlas-c-'));
  try {
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ meta: { appSecret: '${META_APP_SECRET}', verifyToken: '${META_VERIFY_TOKEN}', accessToken: '${META_PAGE_ACCESS_TOKEN}' } }));
    const c = await loadConfig(file, { META_APP_SECRET: 'a', META_VERIFY_TOKEN: 'verify-token', META_PAGE_ACCESS_TOKEN: 'EAA', PORT: '9000' });
    assert.equal(c.meta.appSecret, 'a');
    assert.equal(c.server.port, 9000);
    await assert.rejects(loadConfig(file, {}), /META_APP_SECRET is not set/);
    await assert.rejects(loadConfig(join(dir, 'missing.json'), {}), /cannot read config/);
    await writeFile(file, '{ nope');
    await assert.rejects(loadConfig(file, {}), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the example config is valid', async () => {
  const env = {
    META_APP_SECRET: 'x',
    META_VERIFY_TOKEN: 'verify-token-123',
    META_PAGE_ACCESS_TOKEN: 'EAA',
    ADMIN_TOKEN: 'a'.repeat(32),
    GOOGLE_SPREADSHEET_ID: 'sheet123',
    N8N_WEBHOOK_URL: 'https://n8n.example.com/webhook/leads',
    N8N_WEBHOOK_SECRET: 's',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-100123',
  };
  const c = await loadConfig('examples/config.example.json', env);
  assert.equal(c.sinks.length, 3);
});
