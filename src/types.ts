/** A `fetch`-compatible function. Inject your own for tests, proxies or instrumentation. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Waits for `ms` milliseconds. Injectable so tests do not wait. */
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `value` of a `leadgen` change in a Page webhook notification.
 *
 * ```json
 * { "object": "page", "entry": [ { "id": "<PAGE_ID>", "time": 1700000000,
 *   "changes": [ { "field": "leadgen", "value": {
 *     "leadgen_id": "...", "page_id": "...", "form_id": "...",
 *     "adgroup_id": "...", "ad_id": "...", "created_time": 1700000000 } } ] } ] }
 * ```
 */
export interface LeadgenEvent {
  leadgenId: string;
  pageId: string;
  formId?: string;
  adId?: string;
  adgroupId?: string;
  /** Unix seconds, as sent by Meta. */
  createdTime?: number;
  /** `entry[].time` of the notification. */
  entryTime?: number;
}

/** One answer of a lead form, as returned in `field_data`. */
export interface LeadFieldData {
  name: string;
  values: string[];
}

/** A lead as returned by `GET /{leadgen_id}`. Only `id` is guaranteed; the rest depends on `fields`. */
export interface Lead {
  id: string;
  created_time?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  is_organic?: boolean;
  platform?: string;
  field_data?: LeadFieldData[];
  [key: string]: unknown;
}

/** A lead after field mapping: ordered column names and their values. */
export interface MappedLead {
  /** Configured column names, always in the same order. */
  columns: string[];
  values: Record<string, string>;
  /** Form answers no column used (only with `includeUnmapped`). */
  extra: Record<string, string>;
}

/** Everything a sink gets for one lead. */
export interface LeadContext {
  event: LeadgenEvent;
  lead: Lead;
  mapped: MappedLead;
}
