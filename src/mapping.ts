import { ConfigError } from './errors.js';
import { normalizeBdPhone } from './phone-bd.js';
import type { Lead, LeadgenEvent, MappedLead } from './types.js';

/**
 * Field mapping: turns a lead into named columns.
 *
 * ```json
 * { "columns": [
 *     { "name": "Lead ID",  "from": "lead.id" },
 *     { "name": "Received", "from": "lead.created_time", "transform": ["datetime:Asia/Dhaka"] },
 *     { "name": "Name",     "from": ["field.full_name", "field.first_name"] },
 *     { "name": "Phone",    "from": "field.phone_number", "transform": ["phone_bd"] },
 *     { "name": "Email",    "from": "field.email", "transform": ["trim", "lower"] },
 *     { "name": "Source",   "value": "Facebook Lead Ads" }
 *   ],
 *   "includeUnmapped": true }
 * ```
 *
 * Sources:
 * - `field.<name>`: an answer from `field_data` (several values are joined with `joinWith`)
 * - `lead.<key>`: a top-level lead property from the Graph API (`id`, `created_time`, `ad_id`, ...)
 * - `event.<key>`: a webhook value (`leadgen_id`, `page_id`, `form_id`, `ad_id`, `adgroup_id`, `created_time`)
 * - `value`: a constant
 *
 * `from` may be a list: the first non-empty source wins. `default` is used when all are empty.
 */
export interface ColumnSpec {
  name: string;
  from?: string | string[];
  value?: string;
  transform?: string[];
  default?: string;
}

export interface MappingSpec {
  columns: ColumnSpec[];
  /** Keep form answers that no column used in `extra` (sinks may show them). Default false. */
  includeUnmapped?: boolean;
  /** Separator for multi-value answers. Default ", ". */
  joinWith?: string;
}

export const DEFAULT_MAPPING: MappingSpec = {
  columns: [
    { name: 'lead_id', from: 'lead.id' },
    { name: 'created_time', from: ['lead.created_time', 'event.created_time'], transform: ['datetime'] },
    { name: 'page_id', from: 'event.page_id' },
    { name: 'form_id', from: ['lead.form_id', 'event.form_id'] },
    { name: 'ad_id', from: ['lead.ad_id', 'event.ad_id'] },
    { name: 'full_name', from: ['field.full_name', 'field.name'] },
    { name: 'phone_number', from: ['field.phone_number', 'field.phone'], transform: ['phone_bd'] },
    { name: 'email', from: 'field.email', transform: ['trim', 'lower'] },
  ],
  includeUnmapped: true,
};

type Transform = (value: string) => string;

function formatInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Parse Graph (`2026-11-13T05:12:44+0000`) and webhook (Unix seconds) timestamps. */
export function parseTimestamp(value: string): Date | undefined {
  const v = value.trim();
  if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000);
  if (/^\d{12,14}$/.test(v)) return new Date(Number(v));
  // Graph sends "+0000"; Date.parse wants "+00:00".
  const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function makeTransform(spec: string): Transform {
  const [name, arg] = spec.split(/:(.*)/s, 2) as [string, string | undefined];
  switch (name) {
    case 'trim':
      return (v) => v.trim();
    case 'lower':
      return (v) => v.toLowerCase();
    case 'upper':
      return (v) => v.toUpperCase();
    case 'collapse_spaces':
      return (v) => v.replace(/\s+/g, ' ').trim();
    case 'digits':
      return (v) => v.replace(/\D/g, '');
    case 'phone_bd': {
      const format = (arg ?? 'e164') as 'e164' | 'national' | 'digits';
      if (!['e164', 'national', 'digits'].includes(format)) throw new ConfigError(`phone_bd: unknown format "${arg}"`);
      return (v) => normalizeBdPhone(v, format);
    }
    case 'datetime': {
      // "datetime" -> ISO 8601 UTC; "datetime:Asia/Dhaka" -> "YYYY-MM-DD HH:mm:ss" in that zone.
      if (arg) {
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone: arg });
        } catch {
          throw new ConfigError(`datetime: unknown time zone "${arg}"`);
        }
      }
      return (v) => {
        const d = parseTimestamp(v);
        if (!d) return v;
        return arg ? formatInZone(d, arg) : d.toISOString();
      };
    }
    case 'prefix':
      return (v) => (v ? `${arg ?? ''}${v}` : v);
    case 'truncate': {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1) throw new ConfigError(`truncate: expected a positive length, got "${arg}"`);
      return (v) => (v.length > n ? v.slice(0, n) : v);
    }
    default:
      throw new ConfigError(`unknown transform "${spec}"`);
  }
}

/** Form answers by field name. Meta lower-cases standard field names; custom ones keep their key. */
export function fieldMap(lead: Lead, joinWith = ', '): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of lead.field_data ?? []) {
    if (!f || typeof f.name !== 'string') continue;
    const values = Array.isArray(f.values) ? f.values.map((x) => String(x ?? '')) : [];
    map.set(f.name, values.filter((x) => x !== '').join(joinWith));
  }
  return map;
}

function eventValue(event: LeadgenEvent, key: string): string | undefined {
  const table: Record<string, unknown> = {
    leadgen_id: event.leadgenId,
    page_id: event.pageId,
    form_id: event.formId,
    ad_id: event.adId,
    adgroup_id: event.adgroupId,
    created_time: event.createdTime,
    entry_time: event.entryTime,
  };
  const v = table[key];
  return v === undefined || v === null ? undefined : String(v);
}

function stringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function validateSource(source: string): void {
  if (!/^(field|lead|event)\.[^\s]+$/.test(source)) {
    throw new ConfigError(`invalid source "${source}" (expected field.<name>, lead.<key> or event.<key>)`);
  }
}

interface CompiledColumn {
  name: string;
  sources: string[];
  value: string | undefined;
  transforms: Transform[];
  fallback: string;
}

/** A validated, ready-to-run mapping. Construction throws `ConfigError` on mistakes. */
export class FieldMapper {
  private readonly columns: CompiledColumn[];
  private readonly includeUnmapped: boolean;
  private readonly joinWith: string;

  constructor(spec: MappingSpec = DEFAULT_MAPPING) {
    if (!spec || !Array.isArray(spec.columns)) throw new ConfigError('mapping.columns must be an array');
    const names = new Set<string>();
    this.columns = spec.columns.map((c, i) => {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new ConfigError(`mapping.columns[${i}].name is required`);
      if (names.has(c.name)) throw new ConfigError(`duplicate column name "${c.name}"`);
      names.add(c.name);
      const sources = c.from === undefined ? [] : Array.isArray(c.from) ? c.from : [c.from];
      if (sources.length === 0 && c.value === undefined) {
        throw new ConfigError(`mapping column "${c.name}" needs "from" or "value"`);
      }
      sources.forEach(validateSource);
      if (c.transform !== undefined && !Array.isArray(c.transform)) {
        throw new ConfigError(`mapping column "${c.name}": transform must be an array`);
      }
      return {
        name: c.name,
        sources,
        value: c.value,
        transforms: (c.transform ?? []).map(makeTransform),
        fallback: c.default ?? '',
      };
    });
    this.includeUnmapped = spec.includeUnmapped ?? false;
    this.joinWith = spec.joinWith ?? ', ';
  }

  get columnNames(): string[] {
    return this.columns.map((c) => c.name);
  }

  map(lead: Lead, event: LeadgenEvent): MappedLead {
    const fields = fieldMap(lead, this.joinWith);
    const used = new Set<string>();
    const values: Record<string, string> = {};
    const columns: string[] = [];
    for (const col of this.columns) {
      let raw: string | undefined = col.value;
      for (const source of col.sources) {
        const dot = source.indexOf('.');
        const kind = source.slice(0, dot);
        const key = source.slice(dot + 1);
        let v: string | undefined;
        if (kind === 'field') {
          v = fields.get(key);
          if (v !== undefined) used.add(key);
        } else if (kind === 'lead') {
          v = stringify(lead[key]);
        } else {
          v = eventValue(event, key);
        }
        if (v !== undefined && v !== '') {
          raw = v;
          break;
        }
      }
      let out = raw ?? '';
      if (out !== '') for (const t of col.transforms) out = t(out);
      if (out === '') out = col.fallback;
      values[col.name] = out;
      columns.push(col.name);
    }
    const extra: Record<string, string> = {};
    if (this.includeUnmapped) {
      for (const [name, value] of fields) {
        if (!used.has(name)) extra[name] = value;
      }
    }
    return { columns, values, extra };
  }
}
