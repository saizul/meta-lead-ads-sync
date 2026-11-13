import { SinkError, isRetryableStatus } from '../errors.js';
import type { FetchLike } from '../types.js';

/** Send a request for a sink and turn transport and HTTP failures into `SinkError`s. */
export async function sinkRequest(
  sink: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; text: string }> {
  const { timeoutMs, ...rest } = init;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs ?? 15_000) });
  } catch (cause) {
    throw new SinkError(sink, `request failed: ${(cause as Error)?.message ?? cause}`, { retryable: true, cause });
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new SinkError(sink, `HTTP ${res.status}: ${text.slice(0, 300)}`, {
      retryable: isRetryableStatus(res.status),
      status: res.status,
    });
  }
  return { status: res.status, text };
}
