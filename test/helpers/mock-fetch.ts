import type { FetchLike } from '../../src/types.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type Reply =
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | Error
  | ((call: RecordedCall) => Reply | Promise<Reply>);

interface Route {
  match: (url: URL, method: string) => boolean;
  replies: Reply[];
  /** The last reply repeats when the list runs out. */
}

/**
 * A scripted `fetch`. Register routes with `on()`; each call consumes the next reply of
 * the first matching route (the last reply repeats). Every call is recorded.
 */
export class MockFetch {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Route[] = [];

  on(method: string, pattern: string | RegExp, ...replies: Reply[]): this {
    this.routes.push({
      match: (url, m) =>
        m === method.toUpperCase() &&
        (typeof pattern === 'string' ? url.toString().startsWith(pattern) : pattern.test(url.toString())),
      replies,
    });
    return this;
  }

  callsTo(pattern: string | RegExp): RecordedCall[] {
    return this.calls.filter((c) => (typeof pattern === 'string' ? c.url.startsWith(pattern) : pattern.test(c.url)));
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = { url: url.toString(), method, headers, body: init?.body ? String(init.body) : '' };
    this.calls.push(call);
    const route = this.routes.find((r) => r.match(url, method));
    if (!route) return new Response(JSON.stringify({ error: { message: `no route for ${method} ${url}` } }), { status: 404 });
    let reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0]!;
    while (typeof reply === 'function') reply = await reply(call);
    if (reply instanceof Error) throw reply;
    const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    const status = reply.status ?? 200;
    const nullBody = status === 204 || status === 304;
    return new Response(nullBody ? null : body, {
      status,
      headers: reply.headers ?? { 'content-type': 'application/json' },
    });
  };
}

export const noSleep = async (): Promise<void> => {};
