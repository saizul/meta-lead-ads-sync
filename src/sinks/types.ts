import type { LeadContext } from '../types.js';

/** A destination for leads. `send` must throw `SinkError` (with `retryable`) on failure. */
export interface Sink {
  readonly name: string;
  readonly type: string;
  send(ctx: LeadContext): Promise<void>;
}
