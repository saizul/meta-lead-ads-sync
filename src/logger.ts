export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Keys whose values are never written to logs. */
const SECRET_KEYS = /token|secret|password|authorization|private_key|signature|cookie/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Access tokens in URLs or messages.
    return value.replace(/(access_token=|Bearer\s+)[^\s&"]+/gi, '$1[redacted]');
  }
  return value;
}

/** Mask personal data for logs: keep the first and last characters only. */
export function maskPii(value: string): string {
  const v = value.trim();
  if (v.length <= 4) return '*'.repeat(v.length);
  return `${v.slice(0, 2)}${'*'.repeat(Math.min(8, v.length - 4))}${v.slice(-2)}`;
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

/** One JSON object per line on stdout (or `write`), with secrets redacted. */
export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = options.now ?? (() => new Date());
  const log = (level: Exclude<LogLevel, 'silent'>) => (message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const entry = { time: now().toISOString(), level, msg: redact(message), ...(fields ? (redact(fields) as object) : {}) };
    write(JSON.stringify(entry));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
