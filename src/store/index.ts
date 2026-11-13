import { JsonFileStore } from './json-file.js';
import { MemoryStore } from './memory.js';
import { SqliteStore } from './sqlite.js';
import type { IdempotencyStore } from './types.js';

export { JsonFileStore } from './json-file.js';
export { MemoryStore } from './memory.js';
export { SqliteStore, sqliteAvailable } from './sqlite.js';
export * from './types.js';

export interface StoreConfig {
  type: 'json' | 'sqlite' | 'memory';
  path?: string;
}

export async function openStore(config: StoreConfig): Promise<IdempotencyStore> {
  switch (config.type) {
    case 'memory':
      return new MemoryStore();
    case 'sqlite':
      return SqliteStore.open(config.path ?? './data/leads.sqlite');
    case 'json':
      return JsonFileStore.open(config.path ?? './data/leads.json');
    default:
      throw new TypeError(`unknown store type "${(config as { type: string }).type}"`);
  }
}
