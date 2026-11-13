/** Delivery state of one lead, keyed by `leadgen_id`. */
export interface LeadRecord {
  /**
   * `processing`: a worker owns it; `done`: every sink succeeded; `partial`: some sinks
   * succeeded; `failed`: nothing was delivered (or the lead could not be fetched).
   */
  status: 'processing' | 'done' | 'partial' | 'failed';
  /** Sinks that already received the lead. They are skipped on a retry. */
  delivered: string[];
  attempts: number;
  firstSeenAt: number;
  updatedAt: number;
  pageId?: string;
  formId?: string;
  lastError?: string;
}

export type ClaimResult =
  | { claimed: true; record: LeadRecord }
  | { claimed: false; reason: 'done' | 'in-progress'; record: LeadRecord };

/**
 * Remembers which leads were handled so Meta's retries and duplicate notifications are
 * skipped, and so a partly failed delivery only resends to the sinks that failed.
 */
export interface IdempotencyStore {
  get(leadgenId: string): Promise<LeadRecord | undefined>;
  /**
   * Take ownership of a lead. Fails when it is `done`, or `processing` and updated less
   * than `staleMs` ago (another worker, or a crash that is not yet considered stale).
   */
  claim(leadgenId: string, info: { now: number; staleMs: number; pageId?: string; formId?: string }): Promise<ClaimResult>;
  put(leadgenId: string, record: LeadRecord): Promise<void>;
  /** Forget a lead, so the next notification processes it again. */
  delete(leadgenId: string): Promise<boolean>;
  /**
   * Leads that need another delivery attempt: `failed` and `partial` records with fewer
   * than `maxAttempts` attempts, and `processing` records not updated since `staleBefore`.
   */
  pending(options: { maxAttempts: number; staleBefore: number; limit?: number }): Promise<Array<[string, LeadRecord]>>;
  /** Remove records last updated before `before` (ms epoch). Returns how many were removed. */
  prune(before: number): Promise<number>;
  stats(): Promise<Record<LeadRecord['status'], number>>;
  close(): Promise<void>;
}

/** Shared claim decision for every store implementation. */
export function decideClaim(
  existing: LeadRecord | undefined,
  info: { now: number; staleMs: number; pageId?: string; formId?: string },
): ClaimResult {
  if (existing) {
    if (existing.status === 'done') return { claimed: false, reason: 'done', record: existing };
    if (existing.status === 'processing' && info.now - existing.updatedAt < info.staleMs) {
      return { claimed: false, reason: 'in-progress', record: existing };
    }
    return {
      claimed: true,
      record: { ...existing, status: 'processing', attempts: existing.attempts + 1, updatedAt: info.now },
    };
  }
  const record: LeadRecord = {
    status: 'processing',
    delivered: [],
    attempts: 1,
    firstSeenAt: info.now,
    updatedAt: info.now,
  };
  if (info.pageId) record.pageId = info.pageId;
  if (info.formId) record.formId = info.formId;
  return { claimed: true, record };
}

export function emptyStats(): Record<LeadRecord['status'], number> {
  return { processing: 0, done: 0, partial: 0, failed: 0 };
}

export function isPending(r: LeadRecord, options: { maxAttempts: number; staleBefore: number }): boolean {
  if (r.attempts >= options.maxAttempts) return false;
  if (r.status === 'failed' || r.status === 'partial') return true;
  return r.status === 'processing' && r.updatedAt < options.staleBefore;
}
