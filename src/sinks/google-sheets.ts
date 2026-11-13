import { SinkError } from '../errors.js';
import type { GoogleServiceAccountAuth } from '../google-auth.js';
import type { FetchLike, LeadContext } from '../types.js';
import { sinkRequest } from './http.js';
import type { Sink } from './types.js';

export interface GoogleSheetsSinkOptions {
  name?: string;
  spreadsheetId: string;
  /** A1 range that identifies the table, for example `Leads!A1`. Default `Sheet1!A1`. */
  range?: string;
  /** `RAW` (default) stores values as typed; `USER_ENTERED` parses them like the Sheets UI. */
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  /** `INSERT_ROWS` (default) or `OVERWRITE`. */
  insertDataOption?: 'INSERT_ROWS' | 'OVERWRITE';
  /** Columns to write, in order. Default: the mapping's columns. */
  columns?: string[];
  /** Add a last column with unmapped answers as JSON. */
  extraColumn?: boolean;
  /** Write a header row first when the sheet's first row is empty. Default true. */
  headerRow?: boolean;
  auth: GoogleServiceAccountAuth;
  fetch?: FetchLike;
  baseUrl?: string;
}

/** Prevent formula injection: with USER_ENTERED, a value starting with = + - @ would run as a formula. */
export function escapeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Appends one row per lead with `spreadsheets.values.append`:
 * `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=...`.
 * Share the spreadsheet with the service account e-mail (Editor).
 */
export class GoogleSheetsSink implements Sink {
  readonly type = 'google_sheets';
  readonly name: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private headerChecked = false;

  constructor(private readonly opts: GoogleSheetsSinkOptions) {
    if (!opts.spreadsheetId || !/^[A-Za-z0-9_-]+$/.test(opts.spreadsheetId)) {
      throw new TypeError('google_sheets: invalid spreadsheetId');
    }
    this.name = opts.name ?? 'google_sheets';
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (opts.baseUrl ?? 'https://sheets.googleapis.com').replace(/\/+$/, '');
  }

  get range(): string {
    return this.opts.range ?? 'Sheet1!A1';
  }

  private valuesUrl(range: string, suffix = ''): string {
    return `${this.baseUrl}/v4/spreadsheets/${this.opts.spreadsheetId}/values/${encodeURIComponent(range)}${suffix}`;
  }

  /** The row for a lead, in column order. */
  row(ctx: LeadContext): string[] {
    const columns = this.opts.columns ?? ctx.mapped.columns;
    const userEntered = this.opts.valueInputOption === 'USER_ENTERED';
    const cells = columns.map((c) => ctx.mapped.values[c] ?? '');
    if (this.opts.extraColumn) cells.push(Object.keys(ctx.mapped.extra).length ? JSON.stringify(ctx.mapped.extra) : '');
    return userEntered ? cells.map(escapeCell) : cells;
  }

  headers(ctx: LeadContext): string[] {
    const columns = [...(this.opts.columns ?? ctx.mapped.columns)];
    if (this.opts.extraColumn) columns.push('extra');
    return columns;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    let token: string;
    try {
      token = await this.opts.auth.getAccessToken();
    } catch (error) {
      const retryable = (error as { retryable?: boolean }).retryable === true;
      throw new SinkError(this.name, (error as Error).message, { retryable, cause: error });
    }
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  private async call(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
    try {
      return await sinkRequest(this.name, this.fetchImpl, url, { ...init, headers: await this.authHeaders() });
    } catch (error) {
      // An expired or revoked token: drop it so the retry fetches a new one.
      if (error instanceof SinkError && error.status === 401) {
        this.opts.auth.invalidate();
        throw new SinkError(this.name, error.message.replace(`${this.name}: `, ''), { retryable: true, status: 401 });
      }
      throw error;
    }
  }

  private async append(values: string[][]): Promise<void> {
    const params = new URLSearchParams({
      valueInputOption: this.opts.valueInputOption ?? 'RAW',
      insertDataOption: this.opts.insertDataOption ?? 'INSERT_ROWS',
    });
    await this.call(this.valuesUrl(this.range, `:append?${params}`), {
      method: 'POST',
      body: JSON.stringify({ range: this.range, majorDimension: 'ROWS', values }),
    });
  }

  private async ensureHeader(ctx: LeadContext): Promise<void> {
    if (this.headerChecked || this.opts.headerRow === false) return;
    const sheet = this.range.includes('!') ? this.range.slice(0, this.range.lastIndexOf('!')) : undefined;
    const firstRow = sheet ? `${sheet}!1:1` : '1:1';
    const { text } = await this.call(this.valuesUrl(firstRow), { method: 'GET' });
    let hasHeader = false;
    try {
      const data = JSON.parse(text) as { values?: unknown[][] };
      hasHeader = Array.isArray(data.values) && data.values.length > 0 && data.values[0]!.length > 0;
    } catch {
      // Unreadable answer: treat the sheet as empty and write the header.
    }
    if (!hasHeader) await this.append([this.headers(ctx)]);
    this.headerChecked = true;
  }

  async send(ctx: LeadContext): Promise<void> {
    await this.ensureHeader(ctx);
    await this.append([this.row(ctx)]);
  }
}
