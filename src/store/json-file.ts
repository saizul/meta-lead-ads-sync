import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LeadSyncError } from '../errors.js';
import { MemoryStore } from './memory.js';
import type { LeadRecord } from './types.js';

interface FileShape {
  version: 1;
  leads: Record<string, LeadRecord>;
}

/**
 * A JSON file store: the whole map is kept in memory and written atomically (temp file +
 * rename) after every change. Writes are serialised, so concurrent updates never
 * interleave. Good for up to tens of thousands of leads; use SQLite beyond that.
 */
export class JsonFileStore extends MemoryStore {
  readonly path: string;
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;
  private counter = 0;

  private constructor(path: string) {
    super();
    this.path = path;
  }

  static async open(path: string): Promise<JsonFileStore> {
    const store = new JsonFileStore(path);
    let text: string | undefined;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LeadSyncError(`cannot read store ${path}: ${(error as Error).message}`, { cause: error });
      }
    }
    if (text !== undefined && text.trim() !== '') {
      let data: FileShape;
      try {
        data = JSON.parse(text) as FileShape;
      } catch (error) {
        throw new LeadSyncError(`store ${path} is not valid JSON; fix or move it away`, { cause: error });
      }
      for (const [id, record] of Object.entries(data.leads ?? {})) store.records.set(id, record);
    }
    await mkdir(dirname(path), { recursive: true });
    return store;
  }

  protected override async persist(): Promise<void> {
    this.dirty = true;
    const next = this.chain.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const body: FileShape = { version: 1, leads: Object.fromEntries(this.records) };
      const tmp = `${this.path}.${process.pid}.${++this.counter}.tmp`;
      await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    // Keep the chain alive after a failed write, but report the failure to this caller.
    this.chain = next.catch(() => {});
    await next;
  }

  override async close(): Promise<void> {
    await this.chain;
  }
}
