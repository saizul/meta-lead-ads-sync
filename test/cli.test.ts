import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { run, type CliIo } from '../src/cli.js';
import { silentLogger } from '../src/logger.js';
import { signPayload } from '../src/signature.js';
import { MemoryStore } from '../src/store/memory.js';
import { VERSION } from '../src/version.js';
import { APP_SECRET, PAGE_TOKEN, VERIFY_TOKEN, lead, leadId } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

let dir: string;
let configPath: string;
const N8N = 'https://n8n.example.com/webhook/leads';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mlas-cli-'));
  configPath = join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      meta: { appSecret: '${META_APP_SECRET}', verifyToken: VERIFY_TOKEN, accessToken: PAGE_TOKEN },
      store: { type: 'json', path: join(dir, 'data', 'leads.json') },
      sinks: [{ type: 'webhook', name: 'n8n', url: N8N }],
      logLevel: 'silent',
    }),
  );
});
after(() => rm(dir, { recursive: true, force: true }));

function io(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo & { lines: string[]; errors: string[] } = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { META_APP_SECRET: APP_SECRET },
    lines: out,
    errors: err,
    ...extra,
  };
  return value;
}

test('version and help', async () => {
  const a = io();
  assert.equal(await run(['--version'], a), 0);
  assert.deepEqual(a.lines, [VERSION]);
  const b = io();
  assert.equal(await run(['--help'], b), 0);
  assert.match(b.lines[0]!, /Usage:/);
  assert.equal(await run([], io()), 2);
  const c = io();
  assert.equal(await run(['bogus'], c), 2);
  assert.match(c.errors[0]!, /unknown command/);
  assert.equal(await run(['--nope'], io()), 2);
});

test('phone', async () => {
  const a = io();
  assert.equal(await run(['phone', '01712-345678', '+8801812345678'], a), 0);
  assert.deepEqual(a.lines, ['01712-345678\t+8801712345678\t01712345678\tGrameenphone', '+8801812345678\t+8801812345678\t01812345678\tRobi']);
  const b = io();
  assert.equal(await run(['phone', '123'], b), 1);
  assert.equal(await run(['phone'], io()), 2);
});

test('sign', async () => {
  const body = join(dir, 'body.json');
  await writeFile(body, '{"object":"page"}');
  const a = io();
  assert.equal(await run(['sign', body], a), 0);
  assert.equal(a.lines[0], signPayload('{"object":"page"}', APP_SECRET));
  assert.equal(await run(['sign', body], io({ env: {} })), 2);
});

test('check-config', async () => {
  const a = io();
  assert.equal(await run(['check-config', '--config', configPath], a), 0);
  assert.match(a.lines.join('\n'), /sink: {4}n8n \[webhook\]/);
  assert.ok(!a.lines.join('\n').includes(APP_SECRET), 'secrets are never printed');
  const b = io({ env: {} });
  assert.equal(await run(['check-config', '-c', configPath], b), 2);
  assert.match(b.errors[0]!, /META_APP_SECRET is not set/);
  const c = io({ env: { META_APP_SECRET: 'x', CONFIG_PATH: join(dir, 'missing.json') } });
  assert.equal(await run(['check-config'], c), 2);
});

test('replay and retry', async () => {
  const mock = new MockFetch();
  mock.on('GET', /graph\.facebook\.com/, { json: lead(leadId(1)) });
  mock.on('POST', N8N, { status: 400, text: 'bad' }, { text: 'ok' });
  const deps = { fetch: mock.fetch, sleep: noSleep };
  const a = io({ deps });
  assert.equal(await run(['replay', leadId(1), '--page-id', '123', '-c', configPath], a), 1);
  assert.equal(JSON.parse(a.lines.join('\n')).status, 'failed');
  const b = io({ deps });
  assert.equal(await run(['retry', '-c', configPath], b), 0);
  assert.match(b.lines.at(-1)!, /1 lead\(s\) retried/);
  const c = io({ deps });
  assert.equal(await run(['replay', leadId(1), '-c', configPath], c), 0);
  assert.equal(JSON.parse(c.lines.join('\n')).status, 'duplicate');
  const d = io({ deps });
  assert.equal(await run(['replay', leadId(1), '--force', '-c', configPath], d), 0);
  assert.equal(JSON.parse(d.lines.join('\n')).status, 'done');
  assert.equal(await run(['replay', 'abc', '-c', configPath], io({ deps })), 2);
});

test('serve starts and stops', async () => {
  let stop: (() => Promise<void>) | undefined;
  const a = io({ deps: { logger: silentLogger, store: new MemoryStore() }, onServe: (s) => (stop = s) });
  assert.equal(await run(['serve', '-c', configPath], a), 0);
  assert.ok(stop);
  await stop!();
});
