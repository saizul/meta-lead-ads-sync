import type { GraphClient } from './graph.js';
import { silentLogger, type Logger } from './logger.js';
import type { FieldMapper } from './mapping.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { SinkRoute } from './routing.js';
import type { Sink } from './sinks/types.js';
import type { IdempotencyStore, LeadRecord } from './store/types.js';
import type { Lead, LeadgenEvent } from './types.js';

export type ProcessStatus = 'done' | 'partial' | 'failed' | 'duplicate' | 'in-progress' | 'skipped';

export interface ProcessResult {
  leadgenId: string;
  status: ProcessStatus;
  /** Sinks that have the lead (including earlier attempts). */
  delivered: string[];
  /** Sinks left out because the lead did not match their `when` rule. */
  routedAway?: Array<{ sink: string; reason: string }>;
  errors: Array<{ sink: string; message: string }>;
}

export interface ProcessorOptions {
  graph: Pick<GraphClient, 'getLead'>;
  store: IdempotencyStore;
  sinks: Sink[];
  mapper: FieldMapper;
  /** Mappings by form id, for forms with different questions. */
  formMappers?: Record<string, FieldMapper>;
  /** Routing rules by sink name. A sink without one gets every lead. */
  routes?: Record<string, Pick<SinkRoute, 'evaluate'>>;
  /** Only process these Page ids (all when empty). */
  pageIds?: string[];
  /** Only process these form ids (all when empty). */
  formIds?: string[];
  /** Retry policy for each sink delivery. */
  sinkRetry?: RetryOptions;
  /** A `processing` claim older than this is taken over (crash recovery). Default 10 minutes. */
  staleMs?: number;
  logger?: Logger;
  now?: () => number;
}

/** Fetches, maps and delivers one lead at a time, recording progress in the store. */
export class LeadProcessor {
  private readonly log: Logger;
  private readonly now: () => number;
  readonly staleMs: number;

  constructor(private readonly opts: ProcessorOptions) {
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 10 * 60_000;
  }

  get sinks(): Sink[] {
    return this.opts.sinks;
  }

  private allowed(event: LeadgenEvent): boolean {
    const { pageIds, formIds } = this.opts;
    if (pageIds && pageIds.length > 0 && !pageIds.includes(event.pageId)) return false;
    if (formIds && formIds.length > 0 && (!event.formId || !formIds.includes(event.formId))) return false;
    return true;
  }

  async process(event: LeadgenEvent): Promise<ProcessResult> {
    const id = event.leadgenId;
    if (!this.allowed(event)) {
      this.log.info('lead skipped by page/form filter', { leadgenId: id, pageId: event.pageId, formId: event.formId });
      return { leadgenId: id, status: 'skipped', delivered: [], errors: [] };
    }
    const claimInfo: { now: number; staleMs: number; pageId?: string; formId?: string } = {
      now: this.now(),
      staleMs: this.staleMs,
      pageId: event.pageId,
    };
    if (event.formId) claimInfo.formId = event.formId;
    const claim = await this.opts.store.claim(id, claimInfo);
    if (!claim.claimed) {
      const status = claim.reason === 'done' ? 'duplicate' : 'in-progress';
      this.log.info(`lead ${status}, skipped`, { leadgenId: id });
      return { leadgenId: id, status, delivered: claim.record.delivered, errors: [] };
    }
    const record = claim.record;

    let lead: Lead;
    try {
      lead = await this.opts.graph.getLead(id, event.pageId);
    } catch (error) {
      const message = (error as Error).message;
      await this.save(id, { ...record, status: 'failed', lastError: `graph: ${message}` });
      this.log.error('could not fetch lead', { leadgenId: id, error: message });
      return { leadgenId: id, status: 'failed', delivered: record.delivered, errors: [{ sink: 'graph', message }] };
    }

    const formId = lead.form_id ?? event.formId;
    const mapper = (formId && this.opts.formMappers?.[formId]) || this.opts.mapper;
    const mapped = mapper.map(lead, event);
    const ctx = { event, lead, mapped };

    const delivered = new Set(record.delivered);
    const errors: ProcessResult['errors'] = [];
    const routedAway: NonNullable<ProcessResult['routedAway']> = [];
    const targets: Sink[] = [];
    for (const sink of this.opts.sinks) {
      // A sink that already has the lead keeps it, even if its rule changed since.
      const route = delivered.has(sink.name) ? undefined : this.opts.routes?.[sink.name];
      const decision = route?.evaluate(ctx);
      if (decision && !decision.matched) {
        routedAway.push({ sink: sink.name, reason: decision.reason });
        this.log.info('lead not routed to sink', { leadgenId: id, sink: sink.name, reason: decision.reason });
      } else {
        targets.push(sink);
      }
    }
    for (const sink of targets) {
      if (delivered.has(sink.name)) continue;
      try {
        await withRetry(() => sink.send(ctx), {
          ...this.opts.sinkRetry,
          onRetry: (error, attempt, delayMs) =>
            this.log.warn('sink failed, retrying', {
              leadgenId: id,
              sink: sink.name,
              attempt,
              delayMs,
              error: (error as Error).message,
            }),
        });
        delivered.add(sink.name);
        this.log.info('lead delivered', { leadgenId: id, sink: sink.name });
      } catch (error) {
        const message = (error as Error).message;
        errors.push({ sink: sink.name, message });
        this.log.error('sink failed', { leadgenId: id, sink: sink.name, error: message });
      }
    }
    const all = targets.every((s) => delivered.has(s.name));
    const status: LeadRecord['status'] = all ? 'done' : delivered.size > 0 ? 'partial' : 'failed';
    const next: LeadRecord = { ...record, status, delivered: [...delivered] };
    if (formId) next.formId = formId;
    if (errors.length) next.lastError = errors.map((e) => `${e.sink}: ${e.message}`).join('; ');
    else delete next.lastError;
    await this.save(id, next);
    const result: ProcessResult = { leadgenId: id, status, delivered: [...delivered], errors };
    if (routedAway.length) result.routedAway = routedAway;
    return result;
  }

  private async save(id: string, record: LeadRecord): Promise<void> {
    await this.opts.store.put(id, { ...record, updatedAt: this.now() });
  }

  /** Re-run leads that failed or were left half-done. Returns one result per lead tried. */
  async retryPending(options: { maxAttempts: number; limit?: number }): Promise<ProcessResult[]> {
    const pendingOptions: { maxAttempts: number; staleBefore: number; limit?: number } = {
      maxAttempts: options.maxAttempts,
      staleBefore: this.now() - this.staleMs,
    };
    if (options.limit !== undefined) pendingOptions.limit = options.limit;
    const pending = await this.opts.store.pending(pendingOptions);
    const results: ProcessResult[] = [];
    for (const [leadgenId, record] of pending) {
      const event: LeadgenEvent = { leadgenId, pageId: record.pageId ?? '' };
      if (record.formId) event.formId = record.formId;
      results.push(await this.process(event));
    }
    return results;
  }
}
