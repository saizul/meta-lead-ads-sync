import { signPayload } from '../signature.js';
import type { FetchLike, LeadContext } from '../types.js';
import { sinkRequest } from './http.js';
import type { Sink } from './types.js';

export interface WebhookSinkOptions {
  name?: string;
  url: string;
  /** When set, the body is signed: `X-Signature-256: sha256=<hex HMAC>`. */
  secret?: string;
  headers?: Record<string, string>;
  /** Include the raw Graph API lead and the webhook event. Default true. */
  includeRaw?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * POSTs each lead as JSON, for n8n, Make, Zapier, a CRM or your own endpoint.
 *
 * ```json
 * { "event": "lead.created", "leadgen_id": "...", "page_id": "...", "form_id": "...",
 *   "lead": { "<column>": "<value>" }, "extra": { ... }, "raw": { "lead": {...}, "event": {...} } }
 * ```
 *
 * `Idempotency-Key` carries the leadgen id, so receivers can drop duplicates too.
 */
export class WebhookSink implements Sink {
  readonly type = 'webhook';
  readonly name: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: WebhookSinkOptions) {
    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      throw new TypeError(`webhook: invalid url "${opts.url}"`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('webhook: url must be http(s)');
    this.name = opts.name ?? 'webhook';
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  body(ctx: LeadContext): string {
    const payload: Record<string, unknown> = {
      event: 'lead.created',
      leadgen_id: ctx.event.leadgenId,
      page_id: ctx.event.pageId,
      form_id: ctx.lead.form_id ?? ctx.event.formId ?? null,
      created_time: ctx.lead.created_time ?? null,
      lead: ctx.mapped.values,
      extra: ctx.mapped.extra,
    };
    if (this.opts.includeRaw ?? true) payload.raw = { lead: ctx.lead, event: ctx.event };
    return JSON.stringify(payload);
  }

  async send(ctx: LeadContext): Promise<void> {
    const body = this.body(ctx);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'meta-lead-ads-sync',
      'Idempotency-Key': ctx.event.leadgenId,
      ...this.opts.headers,
    };
    if (this.opts.secret) headers['X-Signature-256'] = signPayload(body, this.opts.secret);
    await sinkRequest(this.name, this.fetchImpl, this.opts.url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: this.opts.timeoutMs,
    });
  }
}
