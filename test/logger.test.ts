import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsonLogger, maskPii, redact } from '../src/logger.js';

test('json logger writes one line per entry and respects the level', () => {
  const lines: string[] = [];
  const log = createJsonLogger({ level: 'info', write: (l) => lines.push(l), now: () => new Date('2026-11-13T00:00:00Z') });
  log.debug('hidden');
  log.info('hello', { leadgenId: '1' });
  log.error('bad', { accessToken: 'EAAsecret', nested: { app_secret: 'x', ok: 1 } });
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { time: '2026-11-13T00:00:00.000Z', level: 'info', msg: 'hello', leadgenId: '1' });
  const e = JSON.parse(lines[1]!);
  assert.equal(e.accessToken, '[redacted]');
  assert.deepEqual(e.nested, { app_secret: '[redacted]', ok: 1 });
});

test('redact strips tokens from strings', () => {
  assert.equal(redact('GET https://graph.facebook.com/v27.0/1?access_token=EAAabc&fields=id'), 'GET https://graph.facebook.com/v27.0/1?access_token=[redacted]&fields=id');
  assert.equal(redact('Authorization: Bearer ya29.abc'), 'Authorization: Bearer [redacted]');
  assert.deepEqual(redact([{ password: 'x' }]), [{ password: '[redacted]' }]);
});

test('silent level', () => {
  const lines: string[] = [];
  const log = createJsonLogger({ level: 'silent', write: (l) => lines.push(l) });
  log.error('x');
  assert.equal(lines.length, 0);
});

test('maskPii', () => {
  assert.equal(maskPii('+8801712345678'), '+8********78');
  assert.equal(maskPii('abc'), '***');
});
