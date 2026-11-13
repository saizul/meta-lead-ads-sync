import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';

/** `sha256=<hex HMAC-SHA256 of body keyed with secret>`, the format Meta uses. */
export function signPayload(body: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'no-secret' };

/**
 * Verify an `X-Hub-Signature-256` header against the raw request body.
 *
 * The HMAC must be computed over the exact bytes Meta sent, before any JSON parsing or
 * re-serialisation (Meta escapes non-ASCII characters, so a re-encoded body would not
 * match). The comparison is constant-time.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  appSecret: string,
): SignatureCheck {
  if (!appSecret) return { ok: false, reason: 'no-secret' };
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return { ok: false, reason: 'missing' };
  const match = /^sha256=([0-9a-f]{64})$/i.exec(value.trim());
  if (!match) return { ok: false, reason: 'malformed' };
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1]!.toLowerCase(), 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

/** Constant-time string comparison for tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'compare').update(a).digest();
  const hb = createHmac('sha256', 'compare').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** `appsecret_proof` for Graph API calls: hex HMAC-SHA256 of the access token keyed with the app secret. */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}
