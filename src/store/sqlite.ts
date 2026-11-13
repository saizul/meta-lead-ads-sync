import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LeadSyncError } from '../errors.js';
import { decideClaim, emptyStats, isPending, type ClaimResult, type IdempotencyStore, type LeadRecord } from './types.js';

// Minimal structural types for node:sqlite, so the package compiles without it.
interface Statement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/** Is `node:sqlite` available (Node 22.13+ / 23.4+ without a flag)? */
export async function sqliteAvailable(): Promise<boolean> {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * SQLite store using Node's built-in `node:sqlite` module (no native add-on to install).
 * Claims run inside `BEGIN IMMEDIATE` transactions, so several processes can share one
 * database file safely.
 */
export class SqliteStore implements IdempotencyStore {
  private constructor(private readonly db: Database) {}

  static async open(path: string): Promise<SqliteStore> {
    let mod: { DatabaseSync: new (path: string) => Database };
    try {
      mod = (await import('node:sqlite')) as unknown as typeof mod;
    } catch (error) {
      throw new LeadSyncError(
        'the SQLite store needs node:sqlite (Node.js 22.13 or newer); use "type": "json" on older versions',
        { cause: error },
      );
    }
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
    const db = new mod.DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS leads (
        leadgen_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        record TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS leads_updated_at ON leads (updated_at);
    `);
    return new SqliteStore(db);
  }

  private read(id: string): LeadRecord | undefined {
    const row = this.db.prepare('SELECT record FROM leads WHERE leadgen_id = ?').get(id);
    return row ? (JSON.parse(String(row.record)) as LeadRecord) : undefined;
  }

  private write(id: string, record: LeadRecord): void {
    this.db
      .prepare(
        `INSERT INTO leads (leadgen_id, status, record, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (leadgen_id) DO UPDATE SET status = excluded.status, record = excluded.record,
         updated_at = excluded.updated_at`,
      )
      .run(id, record.status, JSON.stringify(record), record.updatedAt);
  }

  async get(id: string): Promise<LeadRecord | undefined> {
    return this.read(id);
  }

  async claim(id: string, info: { now: number; staleMs: number; pageId?: string; formId?: string }): Promise<ClaimResult> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = decideClaim(this.read(id), info);
      if (result.claimed) this.write(id, result.record);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async put(id: string, record: LeadRecord): Promise<void> {
    this.write(id, record);
  }

  async delete(id: string): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM leads WHERE leadgen_id = ?').run(id).changes) > 0;
  }

  async pending(options: { maxAttempts: number; staleBefore: number; limit?: number }): Promise<Array<[string, LeadRecord]>> {
    const rows = this.db
      .prepare("SELECT leadgen_id, record FROM leads WHERE status != 'done' ORDER BY updated_at")
      .all();
    const out: Array<[string, LeadRecord]> = [];
    for (const row of rows) {
      const r = JSON.parse(String(row.record)) as LeadRecord;
      if (isPending(r, options)) out.push([String(row.leadgen_id), r]);
      if (options.limit !== undefined && out.length >= options.limit) break;
    }
    return out;
  }

  async prune(before: number): Promise<number> {
    const r = this.db.prepare("DELETE FROM leads WHERE updated_at < ? AND status != 'processing'").run(before);
    return Number(r.changes);
  }

  async stats(): Promise<Record<LeadRecord['status'], number>> {
    const s = emptyStats();
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all()) {
      const status = String(row.status) as LeadRecord['status'];
      if (status in s) s[status] = Number(row.n);
    }
    return s;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
