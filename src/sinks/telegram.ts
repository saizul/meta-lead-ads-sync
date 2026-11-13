import { SinkError } from '../errors.js';
import type { FetchLike, LeadContext } from '../types.js';
import type { Sink } from './types.js';

export interface TelegramSinkOptions {
  name?: string;
  botToken: string;
  chatId: string | number;
  /**
   * Message template. `{{Column}}` is replaced with the (HTML-escaped) mapped value,
   * `{{#all}}` with every non-empty column as "Column: value" lines.
   */
  template?: string;
  /** Telegram forum topic. */
  messageThreadId?: number;
  disableNotification?: boolean;
  fetch?: FetchLike;
  baseUrl?: string;
}

export const DEFAULT_TELEGRAM_TEMPLATE = '<b>New lead</b>\n{{#all}}';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Telegram limits a message to 4096 characters. */
const MAX_LENGTH = 4096;

export function renderTemplate(template: string, ctx: LeadContext): string {
  const all = ctx.mapped.columns
    .filter((c) => (ctx.mapped.values[c] ?? '') !== '')
    .map((c) => `<b>${escapeHtml(c)}:</b> ${escapeHtml(ctx.mapped.values[c]!)}`)
    .concat(Object.entries(ctx.mapped.extra).map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`))
    .join('\n');
  const out = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key: string) => {
    if (key === '#all') return all;
    return escapeHtml(ctx.mapped.values[key] ?? ctx.mapped.extra[key] ?? '');
  });
  return out.length > MAX_LENGTH ? `${out.slice(0, MAX_LENGTH - 1)}…` : out;
}

/** Sends a notification with the Bot API `sendMessage` method (HTML parse mode). */
export class TelegramSink implements Sink {
  readonly type = 'telegram';
  readonly name: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly opts: TelegramSinkOptions) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(opts.botToken ?? '')) throw new TypeError('telegram: invalid botToken');
    if (opts.chatId === undefined || opts.chatId === '') throw new TypeError('telegram: chatId is required');
    this.name = opts.name ?? 'telegram';
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (opts.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  }

  async send(ctx: LeadContext): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: this.opts.chatId,
      text: renderTemplate(this.opts.template ?? DEFAULT_TELEGRAM_TEMPLATE, ctx),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (this.opts.messageThreadId !== undefined) body.message_thread_id = this.opts.messageThreadId;
    if (this.opts.disableNotification) body.disable_notification = true;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/bot${this.opts.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      // Do not include the URL: it contains the bot token.
      throw new SinkError(this.name, `request failed: ${(cause as Error)?.name ?? 'error'}`, { retryable: true });
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!res.ok || data.ok !== true) {
      const err = new SinkError(this.name, `HTTP ${res.status}: ${data.description ?? 'sendMessage failed'}`, {
        retryable: res.status === 429 || res.status >= 500,
        status: res.status,
      });
      if (data.parameters?.retry_after !== undefined) {
        Object.assign(err, { retryAfterMs: data.parameters.retry_after * 1000 });
      }
      throw err;
    }
  }
}
