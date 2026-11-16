import { ConfigError } from './errors.js';
import { fieldMap } from './mapping.js';
import type { LeadContext } from './types.js';

/**
 * Per-sink routing: a sink with a `when` rule only gets the leads that match it.
 *
 * ```json
 * "when": {
 *   "forms": ["222222222222222"],
 *   "organic": false,
 *   "platforms": ["fb", "ig"],
 *   "all": [{ "from": "column.City", "equals": ["Dhaka", "Gazipur"] }],
 *   "any": [{ "from": "field.budget", "matches": "^(50k|1 lakh)" }, { "from": "field.company", "exists": true }],
 *   "none": [{ "from": "field.email", "matches": "@example\\.(com|org)$" }]
 * }
 * ```
 *
 * Every part that is present must hold. `all` needs every condition, `any` at least one,
 * `none` no condition at all. Comparisons ignore case and surrounding spaces.
 */
export interface ConditionSpec {
  /** `field.<name>`, `lead.<key>`, `event.<key>` or `column.<mapped column name>`. */
  from: string;
  /** The value equals this (or one of these). */
  equals?: string | string[];
  /** The value equals none of these. */
  notEquals?: string | string[];
  /** The value matches this regular expression (case-insensitive). */
  matches?: string;
  /** `true`: the value is not empty. `false`: the value is empty or missing. */
  exists?: boolean;
}

export interface RouteSpec {
  /** Only these form ids (an array or a comma-separated string). */
  forms?: string[] | string;
  /** Only these Page ids. */
  pages?: string[] | string;
  /** `lead.is_organic`: `false` for leads from ads, `true` for organic ones. Needs `is_organic` in `meta.fields`. */
  organic?: boolean;
  /** `lead.platform` values such as `fb` or `ig`. Needs `platform` in `meta.fields`. */
  platforms?: string[];
  all?: ConditionSpec[];
  any?: ConditionSpec[];
  none?: ConditionSpec[];
}

export interface RouteDecision {
  matched: boolean;
  /** Why the lead was not routed (empty when it matched). */
  reason: string;
}

type ValueGetter = (ctx: LeadContext) => string;

interface CompiledCondition {
  label: string;
  get: ValueGetter;
  test: (value: string) => boolean;
}

const EVENT_KEYS: Record<string, (ctx: LeadContext) => unknown> = {
  leadgen_id: (c) => c.event.leadgenId,
  page_id: (c) => c.event.pageId,
  form_id: (c) => c.event.formId,
  ad_id: (c) => c.event.adId,
  adgroup_id: (c) => c.event.adgroupId,
  created_time: (c) => c.event.createdTime,
  entry_time: (c) => c.event.entryTime,
};

function norm(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase();
  return JSON.stringify(value).toLowerCase();
}

function getter(source: string, path: string): ValueGetter {
  const m = /^(field|lead|event|column)\.(.+)$/s.exec(source ?? '');
  if (!m) throw new ConfigError(`${path}.from must be field.<name>, lead.<key>, event.<key> or column.<name>`);
  const kind = m[1]!;
  const key = m[2]!;
  switch (kind) {
    case 'field':
      return (c) => fieldMap(c.lead).get(key) ?? '';
    case 'lead':
      return (c) => {
        const v = c.lead[key];
        if (v === undefined || v === null) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      };
    case 'event': {
      const fn = EVENT_KEYS[key];
      if (!fn) throw new ConfigError(`${path}.from: unknown webhook value "${key}" (expected ${Object.keys(EVENT_KEYS).join(', ')})`);
      return (c) => {
        const v = fn(c);
        return v === undefined || v === null ? '' : String(v);
      };
    }
    default:
      return (c) => c.mapped.values[key] ?? '';
  }
}

function list(value: unknown, path: string): string[] {
  const items = typeof value === 'string' || typeof value === 'number' ? [value] : value;
  if (!Array.isArray(items) || items.length === 0) throw new ConfigError(`${path} must be a string or a non-empty array of strings`);
  return items.map((v, i) => {
    if (typeof v !== 'string' && typeof v !== 'number') throw new ConfigError(`${path}[${i}] must be a string`);
    return norm(v);
  });
}

function compileCondition(raw: unknown, path: string): CompiledCondition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${path} must be an object`);
  const c = raw as Record<string, unknown>;
  const known = new Set(['from', 'equals', 'notEquals', 'matches', 'exists']);
  for (const k of Object.keys(c)) if (!known.has(k)) throw new ConfigError(`${path}: unknown key "${k}"`);
  if (typeof c.from !== 'string') throw new ConfigError(`${path}.from is required`);
  const get = getter(c.from, path);
  const tests: Array<(v: string) => boolean> = [];
  const parts: string[] = [];
  if (c.equals !== undefined) {
    const values = list(c.equals, `${path}.equals`);
    tests.push((v) => values.includes(v));
    parts.push(`equals ${values.join('|')}`);
  }
  if (c.notEquals !== undefined) {
    const values = list(c.notEquals, `${path}.notEquals`);
    tests.push((v) => !values.includes(v));
    parts.push(`not ${values.join('|')}`);
  }
  if (c.matches !== undefined) {
    if (typeof c.matches !== 'string' || c.matches === '') throw new ConfigError(`${path}.matches must be a regular expression`);
    let re: RegExp;
    try {
      re = new RegExp(c.matches, 'i');
    } catch (error) {
      throw new ConfigError(`${path}.matches: ${(error as Error).message}`);
    }
    tests.push((v) => re.test(v));
    parts.push(`matches /${c.matches}/`);
  }
  if (c.exists !== undefined) {
    if (typeof c.exists !== 'boolean') throw new ConfigError(`${path}.exists must be true or false`);
    const want = c.exists;
    tests.push((v) => (v !== '') === want);
    parts.push(want ? 'is set' : 'is empty');
  }
  if (tests.length === 0) throw new ConfigError(`${path} needs equals, notEquals, matches or exists`);
  return { label: `${c.from} ${parts.join(' and ')}`, get, test: (v) => tests.every((t) => t(v)) };
}

function conditions(raw: unknown, path: string): CompiledCondition[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError(`${path} must be a non-empty array of conditions`);
  return raw.map((c, i) => compileCondition(c, `${path}[${i}]`));
}

function idList(raw: unknown, path: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
  if (!Array.isArray(items) || items.length === 0) throw new ConfigError(`${path} must be a non-empty array of ids`);
  return items.map((v, i) => {
    const s = typeof v === 'number' ? String(v) : v;
    if (typeof s !== 'string' || !/^\d+$/.test(s)) throw new ConfigError(`${path}[${i}] must be a numeric id`);
    return s;
  });
}

/** A validated `when` rule. Construction throws `ConfigError` on mistakes. */
export class SinkRoute {
  private readonly forms: string[] | undefined;
  private readonly pages: string[] | undefined;
  private readonly organic: boolean | undefined;
  private readonly platforms: string[] | undefined;
  private readonly all: CompiledCondition[] | undefined;
  private readonly any: CompiledCondition[] | undefined;
  private readonly none: CompiledCondition[] | undefined;

  constructor(spec: RouteSpec, path = 'when') {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new ConfigError(`${path} must be an object`);
    const known = new Set(['forms', 'pages', 'organic', 'platforms', 'all', 'any', 'none']);
    for (const k of Object.keys(spec)) if (!known.has(k)) throw new ConfigError(`${path}: unknown key "${k}"`);
    if (Object.keys(spec).length === 0) throw new ConfigError(`${path} must not be empty`);
    this.forms = idList(spec.forms, `${path}.forms`);
    this.pages = idList(spec.pages, `${path}.pages`);
    if (spec.organic !== undefined && typeof spec.organic !== 'boolean') throw new ConfigError(`${path}.organic must be true or false`);
    this.organic = spec.organic;
    this.platforms = spec.platforms === undefined ? undefined : list(spec.platforms, `${path}.platforms`);
    this.all = conditions(spec.all, `${path}.all`);
    this.any = conditions(spec.any, `${path}.any`);
    this.none = conditions(spec.none, `${path}.none`);
  }

  /** Decide whether a lead goes to the sink, with the first reason it does not. */
  evaluate(ctx: LeadContext): RouteDecision {
    const formId = ctx.lead.form_id ?? ctx.event.formId ?? '';
    if (this.forms && !this.forms.includes(formId)) return no(`form ${formId || '(unknown)'} is not in forms`);
    if (this.pages && !this.pages.includes(ctx.event.pageId)) return no(`page ${ctx.event.pageId || '(unknown)'} is not in pages`);
    if (this.organic !== undefined) {
      const v = ctx.lead.is_organic;
      if (typeof v !== 'boolean') return no('is_organic is missing (add it to meta.fields)');
      if (v !== this.organic) return no(`lead is ${v ? 'organic' : 'from an ad'}`);
    }
    if (this.platforms) {
      const p = norm(ctx.lead.platform);
      if (!this.platforms.includes(p)) return no(`platform ${p || '(unknown)'} is not in platforms`);
    }
    for (const c of this.all ?? []) {
      if (!c.test(norm(c.get(ctx)))) return no(`all: ${c.label} failed`);
    }
    if (this.any && !this.any.some((c) => c.test(norm(c.get(ctx))))) {
      return no(`any: none of ${this.any.map((c) => c.label).join('; ')}`);
    }
    for (const c of this.none ?? []) {
      if (c.test(norm(c.get(ctx)))) return no(`none: ${c.label} matched`);
    }
    return { matched: true, reason: '' };
  }

  matches(ctx: LeadContext): boolean {
    return this.evaluate(ctx).matched;
  }
}

function no(reason: string): RouteDecision {
  return { matched: false, reason };
}
