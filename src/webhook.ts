import type { LeadgenEvent } from './types.js';
import { safeEqual } from './signature.js';

export type VerificationResult =
  | { ok: true; challenge: string }
  | { ok: false; status: 400 | 403; reason: string };

/**
 * Handle the GET verification request Meta sends when you subscribe a webhook:
 * `?hub.mode=subscribe&hub.challenge=<int>&hub.verify_token=<your token>`.
 * Respond with the challenge when the token matches.
 */
export function handleVerification(params: URLSearchParams, verifyToken: string): VerificationResult {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode !== 'subscribe' || token === null || challenge === null) {
    return { ok: false, status: 400, reason: 'missing hub.mode, hub.verify_token or hub.challenge' };
  }
  if (!verifyToken || !safeEqual(token, verifyToken)) {
    return { ok: false, status: 403, reason: 'verify token mismatch' };
  }
  // Meta documents the challenge as an int. Refuse anything else so the endpoint
  // can not be used to reflect arbitrary content.
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(challenge)) {
    return { ok: false, status: 400, reason: 'invalid hub.challenge' };
  }
  return { ok: true, challenge };
}

export interface ParseResult {
  events: LeadgenEvent[];
  /** Changes for fields other than `leadgen`, or malformed leadgen changes. */
  ignored: number;
  object: string | undefined;
}

function idString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Extract `leadgen` changes from a webhook notification body.
 *
 * A notification can batch several entries and several changes per entry, and may mix
 * other subscribed fields; everything that is not a well-formed `leadgen` change is
 * counted in `ignored`. Duplicate `leadgen_id`s inside one body are returned once.
 */
export function parseLeadgenEvents(payload: unknown): ParseResult {
  const result: ParseResult = { events: [], ignored: 0, object: undefined };
  if (!payload || typeof payload !== 'object') return result;
  const body = payload as { object?: unknown; entry?: unknown };
  result.object = typeof body.object === 'string' ? body.object : undefined;
  if (!Array.isArray(body.entry)) return result;
  const seen = new Set<string>();
  for (const entry of body.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; time?: unknown; changes?: unknown };
    if (!Array.isArray(e.changes)) continue;
    for (const change of e.changes) {
      const c = (change ?? {}) as { field?: unknown; value?: unknown };
      if (c.field !== 'leadgen' || !c.value || typeof c.value !== 'object') {
        result.ignored++;
        continue;
      }
      const v = c.value as Record<string, unknown>;
      const leadgenId = idString(v.leadgen_id);
      const pageId = idString(v.page_id) ?? idString(e.id);
      if (!leadgenId || !pageId) {
        result.ignored++;
        continue;
      }
      if (seen.has(leadgenId)) continue;
      seen.add(leadgenId);
      const event: LeadgenEvent = { leadgenId, pageId };
      const formId = idString(v.form_id);
      const adId = idString(v.ad_id);
      const adgroupId = idString(v.adgroup_id);
      const createdTime = num(v.created_time);
      const entryTime = num(e.time);
      if (formId) event.formId = formId;
      if (adId) event.adId = adId;
      if (adgroupId) event.adgroupId = adgroupId;
      if (createdTime !== undefined) event.createdTime = createdTime;
      if (entryTime !== undefined) event.entryTime = entryTime;
      result.events.push(event);
    }
  }
  return result;
}
