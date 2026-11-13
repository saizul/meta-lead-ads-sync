import { decideClaim, emptyStats, isPending, type ClaimResult, type IdempotencyStore, type LeadRecord } from './types.js';

/** In-memory store. Lost on restart; for tests and single-shot use. */
export class MemoryStore implements IdempotencyStore {
  protected readonly records = new Map<string, LeadRecord>();

  async get(id: string): Promise<LeadRecord | undefined> {
    const r = this.records.get(id);
    return r ? structuredClone(r) : undefined;
  }

  async claim(id: string, info: { now: number; staleMs: number; pageId?: string; formId?: string }): Promise<ClaimResult> {
    const result = decideClaim(this.records.get(id), info);
    if (result.claimed) {
      this.records.set(id, structuredClone(result.record));
      await this.persist();
    }
    return structuredClone(result);
  }

  async put(id: string, record: LeadRecord): Promise<void> {
    this.records.set(id, structuredClone(record));
    await this.persist();
  }

  async delete(id: string): Promise<boolean> {
    const had = this.records.delete(id);
    if (had) await this.persist();
    return had;
  }

  async pending(options: { maxAttempts: number; staleBefore: number; limit?: number }): Promise<Array<[string, LeadRecord]>> {
    const out: Array<[string, LeadRecord]> = [];
    for (const [id, r] of this.records) {
      if (isPending(r, options)) out.push([id, structuredClone(r)]);
      if (options.limit !== undefined && out.length >= options.limit) break;
    }
    return out;
  }

  async prune(before: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.records) {
      if (r.updatedAt < before && r.status !== 'processing') {
        this.records.delete(id);
        n++;
      }
    }
    if (n) await this.persist();
    return n;
  }

  async stats(): Promise<Record<LeadRecord['status'], number>> {
    const s = emptyStats();
    for (const r of this.records.values()) s[r.status]++;
    return s;
  }

  get size(): number {
    return this.records.size;
  }

  async close(): Promise<void> {}

  /** Hook for subclasses that write the map somewhere. */
  protected async persist(): Promise<void> {}
}
