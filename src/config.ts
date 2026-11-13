import { readFile } from 'node:fs/promises';
import { ConfigError } from './errors.js';
import { DEFAULT_GRAPH_VERSION } from './graph.js';
import type { LogLevel } from './logger.js';
import { DEFAULT_MAPPING, FieldMapper, type MappingSpec } from './mapping.js';
import type { StoreConfig } from './store/index.js';

export interface GoogleSheetsSinkConfig {
  type: 'google_sheets';
  name?: string;
  enabled?: boolean;
  spreadsheetId: string;
  range?: string;
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  insertDataOption?: 'INSERT_ROWS' | 'OVERWRITE';
  columns?: string[];
  extraColumn?: boolean;
  headerRow?: boolean;
  /** Path to the service account key file. */
  credentialsFile?: string;
  /** The key file contents (for secrets passed as environment variables). */
  credentialsJson?: string;
  /** Domain-wide delegation user, rarely needed. */
  subject?: string;
}

export interface WebhookSinkConfig {
  type: 'webhook';
  name?: string;
  enabled?: boolean;
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  includeRaw?: boolean;
  timeoutMs?: number;
}

export interface TelegramSinkConfig {
  type: 'telegram';
  name?: string;
  enabled?: boolean;
  botToken: string;
  chatId: string | number;
  template?: string;
  messageThreadId?: number;
  disableNotification?: boolean;
}

export type SinkConfig = GoogleSheetsSinkConfig | WebhookSinkConfig | TelegramSinkConfig;

export interface AppConfig {
  server: {
    host: string;
    port: number;
    webhookPath: string;
    maxBodyBytes: number;
    /**
     * `immediate` (default): answer 200 as soon as the signature is valid and process in
     * the background; failures are retried by the service. `after-processing`: answer
     * only when every lead is delivered, and 500 otherwise so Meta retries.
     */
    ackMode: 'immediate' | 'after-processing';
    /** Bearer token for the /admin endpoints. Admin endpoints are off without it. */
    adminToken?: string;
  };
  meta: {
    appSecret: string;
    verifyToken: string;
    /** Page access token used for every Page without its own entry in `pageTokens`. */
    accessToken?: string;
    pageTokens: Record<string, string>;
    graphVersion: string;
    fields?: string[];
    appSecretProof: boolean;
    pageIds: string[];
    formIds: string[];
  };
  store: StoreConfig & { retentionDays: number };
  mapping: MappingSpec;
  formMappings: Record<string, MappingSpec>;
  sinks: SinkConfig[];
  processing: {
    concurrency: number;
    /** How often failed and partial leads are retried. 0 disables. */
    retryIntervalSeconds: number;
    /** Give up on a lead after this many attempts. */
    maxAttempts: number;
    /** Attempts per sink delivery inside one attempt. */
    sinkRetryAttempts: number;
  };
  logLevel: LogLevel;
}

type Env = Record<string, string | undefined>;

/**
 * Replace `${NAME}` and `${NAME:-default}` in every string of the parsed config. A
 * reference to an unset variable without a default is an error, so a missing secret is
 * caught at start-up instead of at the first lead.
 */
export function substituteEnv(value: unknown, env: Env, path = '$'): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${path}: environment variable ${name} is not set`);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => substituteEnv(v, env, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteEnv(v, env, `${path}.${k}`);
    return out;
  }
  return value;
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ConfigError(`${path} is required`);
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new ConfigError(`${path} must be a string`);
  return String(value);
}

function int(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${path} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new ConfigError(`${path} must be true or false`);
}

function strList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array of strings`);
  return value.map((v, i) => str(v, `${path}[${i}]`, true)!);
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${path} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseSink(raw: unknown, i: number): SinkConfig {
  const path = `sinks[${i}]`;
  const s = obj(raw, path);
  const type = s.type;
  const name = str(s.name, `${path}.name`);
  const enabled = bool(s.enabled, `${path}.enabled`, true);
  const base = { ...(name ? { name } : {}), enabled };
  if (type === 'google_sheets') {
    const credentialsFile = str(s.credentialsFile, `${path}.credentialsFile`);
    const credentialsJson = str(s.credentialsJson, `${path}.credentialsJson`);
    if (enabled && !credentialsFile && !credentialsJson) {
      throw new ConfigError(`${path} needs credentialsFile or credentialsJson`);
    }
    const out: GoogleSheetsSinkConfig = {
      type,
      ...base,
      spreadsheetId: str(s.spreadsheetId, `${path}.spreadsheetId`, true)!,
      valueInputOption: oneOf(s.valueInputOption, `${path}.valueInputOption`, ['RAW', 'USER_ENTERED'] as const, 'RAW'),
      insertDataOption: oneOf(s.insertDataOption, `${path}.insertDataOption`, ['INSERT_ROWS', 'OVERWRITE'] as const, 'INSERT_ROWS'),
      extraColumn: bool(s.extraColumn, `${path}.extraColumn`, false),
      headerRow: bool(s.headerRow, `${path}.headerRow`, true),
    };
    const range = str(s.range, `${path}.range`);
    if (range) out.range = range;
    if (s.columns !== undefined) out.columns = strList(s.columns, `${path}.columns`);
    if (credentialsFile) out.credentialsFile = credentialsFile;
    if (credentialsJson) out.credentialsJson = credentialsJson;
    const subject = str(s.subject, `${path}.subject`);
    if (subject) out.subject = subject;
    return out;
  }
  if (type === 'webhook') {
    const url = str(s.url, `${path}.url`, true)!;
    if (!/^https?:\/\//i.test(url)) throw new ConfigError(`${path}.url must be an http(s) URL`);
    const out: WebhookSinkConfig = { type, ...base, url, includeRaw: bool(s.includeRaw, `${path}.includeRaw`, true) };
    const secret = str(s.secret, `${path}.secret`);
    if (secret) out.secret = secret;
    if (s.headers !== undefined) {
      const h = obj(s.headers, `${path}.headers`);
      out.headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, str(v, `${path}.headers.${k}`, true)!]));
    }
    if (s.timeoutMs !== undefined) out.timeoutMs = int(s.timeoutMs, `${path}.timeoutMs`, 15000, 100, 120000);
    return out;
  }
  if (type === 'telegram') {
    const out: TelegramSinkConfig = {
      type,
      ...base,
      botToken: str(s.botToken, `${path}.botToken`, true)!,
      chatId: str(s.chatId, `${path}.chatId`, true)!,
      disableNotification: bool(s.disableNotification, `${path}.disableNotification`, false),
    };
    const template = str(s.template, `${path}.template`);
    if (template) out.template = template;
    if (s.messageThreadId !== undefined) {
      out.messageThreadId = int(s.messageThreadId, `${path}.messageThreadId`, 0, 1, Number.MAX_SAFE_INTEGER);
    }
    return out;
  }
  throw new ConfigError(`${path}.type must be google_sheets, webhook or telegram`);
}

/** Validate a parsed (and env-substituted) configuration object and fill in defaults. */
export function parseConfig(input: unknown): AppConfig {
  const root = obj(input, 'config');
  const server = obj(root.server, 'server');
  const meta = obj(root.meta, 'meta');
  const store = obj(root.store, 'store');
  const processing = obj(root.processing, 'processing');

  const appSecret = str(meta.appSecret, 'meta.appSecret', true)!;
  const verifyToken = str(meta.verifyToken, 'meta.verifyToken', true)!;
  if (verifyToken.length < 8) throw new ConfigError('meta.verifyToken must be at least 8 characters');

  const webhookPath = str(server.webhookPath, 'server.webhookPath') ?? '/webhook';
  if (!webhookPath.startsWith('/')) throw new ConfigError('server.webhookPath must start with "/"');

  const pageTokensRaw = obj(meta.pageTokens, 'meta.pageTokens');
  const pageTokens: Record<string, string> = {};
  for (const [page, token] of Object.entries(pageTokensRaw)) {
    if (!/^\d+$/.test(page)) throw new ConfigError(`meta.pageTokens: "${page}" is not a Page id`);
    pageTokens[page] = str(token, `meta.pageTokens.${page}`, true)!;
  }
  const accessToken = str(meta.accessToken, 'meta.accessToken');
  if (!accessToken && Object.keys(pageTokens).length === 0) {
    throw new ConfigError('meta.accessToken or meta.pageTokens is required');
  }

  const mapping = (root.mapping as MappingSpec | undefined) ?? DEFAULT_MAPPING;
  new FieldMapper(mapping); // validate now
  const formMappingsRaw = obj(root.formMappings, 'formMappings');
  const formMappings: Record<string, MappingSpec> = {};
  for (const [form, spec] of Object.entries(formMappingsRaw)) {
    try {
      new FieldMapper(spec as MappingSpec);
    } catch (error) {
      throw new ConfigError(`formMappings.${form}: ${(error as Error).message}`);
    }
    formMappings[form] = spec as MappingSpec;
  }

  if (root.sinks !== undefined && !Array.isArray(root.sinks)) throw new ConfigError('sinks must be an array');
  const sinks = ((root.sinks as unknown[] | undefined) ?? []).map(parseSink);
  const names = new Set<string>();
  for (const s of sinks) {
    const n = s.name ?? s.type;
    if (names.has(n)) throw new ConfigError(`two sinks are named "${n}"; give each a unique "name"`);
    names.add(n);
  }

  const graphVersion = str(meta.graphVersion, 'meta.graphVersion') ?? DEFAULT_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new ConfigError('meta.graphVersion must look like v27.0');

  const config: AppConfig = {
    server: {
      host: str(server.host, 'server.host') ?? '0.0.0.0',
      port: int(server.port, 'server.port', 8080, 0, 65535),
      webhookPath,
      maxBodyBytes: int(server.maxBodyBytes, 'server.maxBodyBytes', 1024 * 1024, 1024, 20 * 1024 * 1024),
      ackMode: oneOf(server.ackMode, 'server.ackMode', ['immediate', 'after-processing'] as const, 'immediate'),
    },
    meta: {
      appSecret,
      verifyToken,
      pageTokens,
      graphVersion,
      appSecretProof: bool(meta.appSecretProof, 'meta.appSecretProof', true),
      pageIds: strList(meta.pageIds, 'meta.pageIds'),
      formIds: strList(meta.formIds, 'meta.formIds'),
    },
    store: {
      type: oneOf(store.type, 'store.type', ['json', 'sqlite', 'memory'] as const, 'json'),
      retentionDays: int(store.retentionDays, 'store.retentionDays', 90, 0, 3650),
    },
    mapping,
    formMappings,
    sinks,
    processing: {
      concurrency: int(processing.concurrency, 'processing.concurrency', 2, 1, 32),
      retryIntervalSeconds: int(processing.retryIntervalSeconds, 'processing.retryIntervalSeconds', 300, 0, 86400),
      maxAttempts: int(processing.maxAttempts, 'processing.maxAttempts', 8, 1, 100),
      sinkRetryAttempts: int(processing.sinkRetryAttempts, 'processing.sinkRetryAttempts', 3, 1, 10),
    },
    logLevel: oneOf(root.logLevel, 'logLevel', ['debug', 'info', 'warn', 'error', 'silent'] as const, 'info'),
  };
  if (accessToken) config.meta.accessToken = accessToken;
  if (meta.fields !== undefined) config.meta.fields = strList(meta.fields, 'meta.fields');
  const storePath = str(store.path, 'store.path');
  if (storePath) config.store.path = storePath;
  const adminToken = str(server.adminToken, 'server.adminToken');
  if (adminToken) {
    if (adminToken.length < 16) throw new ConfigError('server.adminToken must be at least 16 characters');
    config.server.adminToken = adminToken;
  }
  return config;
}

/** Read a JSON config file, substitute `${ENV}` references and validate it. */
export async function loadConfig(path: string, env: Env = process.env): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read config ${path}: ${(error as Error).message}`, { cause: error });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config ${path} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  // PORT is the usual convention on container platforms.
  const resolved = obj(substituteEnv(data, env), 'config');
  if (env.PORT && (resolved.server === undefined || (resolved.server as Record<string, unknown>).port === undefined)) {
    resolved.server = { ...obj(resolved.server, 'server'), port: env.PORT };
  }
  return parseConfig(resolved);
}
