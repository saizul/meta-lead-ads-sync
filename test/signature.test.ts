import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { appSecretProof, safeEqual, signPayload, verifySignature } from '../src/signature.js';

const SECRET = 'app-secret';

test('signPayload matches a plain HMAC-SHA256', () => {
  const body = '{"object":"page"}';
  const expected = createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(signPayload(body, SECRET), `sha256=${expected}`);
});

test('verifySignature accepts the exact raw bytes', () => {
  const raw = Buffer.from('{"object":"page","entry":[]}');
  assert.deepEqual(verifySignature(raw, signPayload(raw, SECRET), SECRET), { ok: true });
  // Upper-case hex and surrounding space are fine.
  assert.equal(verifySignature(raw, `  ${signPayload(raw, SECRET).toUpperCase().replace('SHA256', 'sha256')} `, SECRET).ok, true);
  // Header arrays (repeated headers) use the first value.
  assert.equal(verifySignature(raw, [signPayload(raw, SECRET), 'x'], SECRET).ok, true);
});

test('verifySignature hashes the escaped body Meta sends, not a re-encoded one', () => {
  const sent = Buffer.from('{"name":"\\u09b0\\u09b9\\u09bf\\u09ae"}'); // escaped unicode as sent
  const reencoded = Buffer.from(JSON.stringify(JSON.parse(sent.toString())));
  const header = signPayload(sent, SECRET);
  assert.equal(verifySignature(sent, header, SECRET).ok, true);
  assert.deepEqual(verifySignature(reencoded, header, SECRET), { ok: false, reason: 'mismatch' });
});

test('verifySignature rejects missing, malformed and wrong signatures', () => {
  const raw = Buffer.from('{}');
  assert.deepEqual(verifySignature(raw, undefined, SECRET), { ok: false, reason: 'missing' });
  assert.deepEqual(verifySignature(raw, '', SECRET), { ok: false, reason: 'missing' });
  assert.deepEqual(verifySignature(raw, 'sha1=abc', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifySignature(raw, 'sha256=' + 'z'.repeat(64), SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifySignature(raw, signPayload(raw, 'other'), SECRET), { ok: false, reason: 'mismatch' });
  assert.deepEqual(verifySignature(Buffer.from('{ }'), signPayload(raw, SECRET), SECRET), { ok: false, reason: 'mismatch' });
  assert.deepEqual(verifySignature(raw, signPayload(raw, SECRET), ''), { ok: false, reason: 'no-secret' });
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

test('appSecretProof is the hex HMAC of the token keyed with the app secret', () => {
  assert.equal(appSecretProof('token', SECRET), createHmac('sha256', SECRET).update('token').digest('hex'));
  assert.match(appSecretProof('token', SECRET), /^[0-9a-f]{64}$/);
});
