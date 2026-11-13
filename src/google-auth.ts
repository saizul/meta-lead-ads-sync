import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LeadSyncError, isRetryableStatus } from './errors.js';
import type { FetchLike } from './types.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** The fields of a Google service account key file that are used here. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

export function parseServiceAccount(json: string): ServiceAccountKey {
  let data: Partial<ServiceAccountKey> & { type?: string };
  try {
    data = JSON.parse(json) as typeof data;
  } catch (cause) {
    throw new LeadSyncError('service account key is not valid JSON', { cause });
  }
  if (data.type !== undefined && data.type !== 'service_account') {
    throw new LeadSyncError(`expected a service account key, got type "${data.type}"`);
  }
  if (!data.client_email || !data.private_key) {
    throw new LeadSyncError('service account key needs client_email and private_key');
  }
  return {
    client_email: data.client_email,
    // Keys pasted into environment variables often have literal "\n".
    private_key: data.private_key.replace(/\\n/g, '\n'),
    ...(data.private_key_id ? { private_key_id: data.private_key_id } : {}),
    ...(data.token_uri ? { token_uri: data.token_uri } : {}),
  };
}

export async function loadServiceAccount(path: string): Promise<ServiceAccountKey> {
  try {
    return parseServiceAccount(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof LeadSyncError) throw error;
    throw new LeadSyncError(`cannot read service account key ${path}: ${(error as Error).message}`, { cause: error });
  }
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * Build a signed RS256 JWT assertion for the OAuth 2.0 JWT bearer flow:
 * header `{alg: RS256, typ: JWT, kid}`, claims `iss`, `scope`, `aud`, `iat`, `exp` (at most one hour).
 */
export function createJwtAssertion(
  key: ServiceAccountKey,
  scopes: string[],
  nowSeconds: number,
  lifetimeSeconds = 3600,
  subject?: string,
): string {
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.private_key_id) header.kid = key.private_key_id;
  const claims: Record<string, string | number> = {
    iss: key.client_email,
    scope: scopes.join(' '),
    aud: key.token_uri ?? GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + Math.min(3600, lifetimeSeconds),
  };
  if (subject) claims.sub = subject;
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  } catch (cause) {
    throw new LeadSyncError('cannot sign the JWT: is private_key a valid PEM key?', { cause });
  }
  return `${unsigned}.${b64url(signature)}`;
}

export interface GoogleAuthOptions {
  key: ServiceAccountKey;
  scopes?: string[];
  subject?: string;
  fetch?: FetchLike;
  now?: () => number;
}

/** Service account access tokens, cached until one minute before they expire. */
export class GoogleServiceAccountAuth {
  private token: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: GoogleAuthOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
  }

  get email(): string {
    return this.opts.key.client_email;
  }

  invalidate(): void {
    this.token = undefined;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - 60_000) return this.token.value;
    // Concurrent callers share one token request.
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const nowMs = this.now();
    const assertion = createJwtAssertion(
      this.opts.key,
      this.opts.scopes ?? [SHEETS_SCOPE],
      Math.floor(nowMs / 1000),
      3600,
      this.opts.subject,
    );
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.key.token_uri ?? GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new LeadSyncError(`Google token request failed: ${(cause as Error)?.message}`, { retryable: true, cause });
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      throw new LeadSyncError(
        `Google token request failed (HTTP ${res.status}): ${data.error ?? 'no access_token'}${
          data.error_description ? ` - ${data.error_description}` : ''
        }`,
        { retryable: isRetryableStatus(res.status) },
      );
    }
    this.token = { value: data.access_token, expiresAt: nowMs + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }
}
