import { GraphApiError, isRetryableStatus } from './errors.js';
import type { Logger } from './logger.js';
import { withRetry, type RetryOptions } from './retry.js';
import { appSecretProof } from './signature.js';
import type { FetchLike, Lead } from './types.js';

export const DEFAULT_GRAPH_VERSION = 'v27.0';

/** Fields documented for a lead in Meta's "Retrieving Leads" guide. Extend with `fields` in the config. */
export const DEFAULT_LEAD_FIELDS = ['id', 'created_time', 'ad_id', 'form_id', 'field_data'];

/**
 * Graph API error codes that mean "try again later": unknown/service errors (1, 2),
 * rate limits (4, 17, 32, 341, 613, 80000-80014 business use case limits).
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

export interface GraphClientOptions {
  /** Page access token, or a function that returns the token for a Page id. */
  accessToken: string | ((pageId: string | undefined) => string | undefined);
  /** When set, `appsecret_proof` is added to every call. */
  appSecret?: string;
  version?: string;
  baseUrl?: string;
  fields?: string[];
  timeoutMs?: number;
  retry?: RetryOptions;
  fetch?: FetchLike;
  logger?: Logger;
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
}

export function isRetryableGraphCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  return RETRYABLE_CODES.has(code) || (code >= 80000 && code <= 80014);
}

export class GraphClient {
  readonly version: string;
  readonly baseUrl: string;
  readonly fields: string[];
  private readonly opts: GraphClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: GraphClientOptions) {
    this.opts = options;
    this.version = options.version ?? DEFAULT_GRAPH_VERSION;
    if (!/^v\d+\.\d+$/.test(this.version)) throw new TypeError(`invalid Graph API version "${this.version}"`);
    this.baseUrl = (options.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    this.fields = options.fields && options.fields.length > 0 ? options.fields : DEFAULT_LEAD_FIELDS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private token(pageId: string | undefined): string {
    const t = typeof this.opts.accessToken === 'function' ? this.opts.accessToken(pageId) : this.opts.accessToken;
    if (!t) throw new GraphApiError(`no access token for page ${pageId ?? '(unknown)'}`, { status: 0, retryable: false });
    return t;
  }

  /** Build the request URL for a lead. The token is sent in the Authorization header, not the URL. */
  leadUrl(leadgenId: string, token: string): string {
    if (!/^\d{1,32}$/.test(leadgenId)) throw new GraphApiError(`invalid leadgen id "${leadgenId}"`, { status: 0, retryable: false });
    const url = new URL(`${this.baseUrl}/${this.version}/${leadgenId}`);
    url.searchParams.set('fields', this.fields.join(','));
    if (this.opts.appSecret) url.searchParams.set('appsecret_proof', appSecretProof(token, this.opts.appSecret));
    return url.toString();
  }

  /** `GET /{leadgen_id}?fields=...` with retries on transient errors. */
  async getLead(leadgenId: string, pageId?: string): Promise<Lead> {
    const token = this.token(pageId);
    const url = this.leadUrl(leadgenId, token);
    return withRetry(() => this.request(url, token), {
      ...this.opts.retry,
      onRetry: (error, attempt, delayMs) => {
        this.opts.logger?.warn('graph request failed, retrying', {
          leadgenId,
          attempt,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        this.opts.retry?.onRetry?.(error, attempt, delayMs);
      },
    });
  }

  private async request(url: string, token: string): Promise<Lead> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (cause) {
      throw new GraphApiError(`Graph API request failed: ${(cause as Error)?.message ?? cause}`, {
        status: 0,
        retryable: true,
        cause,
      });
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new GraphApiError(`Graph API returned invalid JSON (HTTP ${res.status})`, {
        status: res.status,
        retryable: isRetryableStatus(res.status),
      });
    }
    const err = (body as GraphErrorBody).error;
    if (!res.ok || err) {
      const code = err?.code;
      throw new GraphApiError(`Graph API error${code !== undefined ? ` ${code}` : ''}: ${err?.message ?? `HTTP ${res.status}`}`, {
        status: res.status,
        code,
        subcode: err?.error_subcode,
        type: err?.type,
        fbtraceId: err?.fbtrace_id,
        retryable: err?.is_transient === true || isRetryableGraphCode(code) || (code === undefined && isRetryableStatus(res.status)),
      });
    }
    const lead = body as Lead;
    if (!lead || typeof lead.id !== 'string') {
      throw new GraphApiError('Graph API response has no lead id', { status: res.status, retryable: false });
    }
    return lead;
  }
}
