import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { silentLogger, type Logger } from './logger.js';
import type { LeadProcessor, ProcessResult } from './processor.js';
import type { WorkQueue } from './queue.js';
import { SIGNATURE_HEADER, safeEqual, verifySignature } from './signature.js';
import type { IdempotencyStore } from './store/types.js';
import type { LeadgenEvent } from './types.js';
import { handleVerification, parseLeadgenEvents } from './webhook.js';

export interface HandlerOptions {
  appSecret: string;
  verifyToken: string;
  webhookPath?: string;
  maxBodyBytes?: number;
  ackMode?: 'immediate' | 'after-processing';
  adminToken?: string;
  processor: LeadProcessor;
  queue: WorkQueue<LeadgenEvent>;
  store: IdempotencyStore;
  logger?: Logger;
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string | object, type?: string): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type ?? (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json'),
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

const OK_STATUSES = new Set(['done', 'duplicate', 'skipped']);

/** Create the request handler. Use it with `node:http`, or mount it in another server. */
export function createHandler(opts: HandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = opts.logger ?? silentLogger;
  const path = opts.webhookPath ?? '/webhook';
  const limit = opts.maxBodyBytes ?? 1024 * 1024;

  const authorized = (req: IncomingMessage): boolean => {
    if (!opts.adminToken) return false;
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m !== null && safeEqual(m[1]!.trim(), opts.adminToken);
  };

  async function webhookPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readBody(req, limit);
    } catch (error) {
      if (error instanceof BodyTooLarge) return send(res, 413, 'payload too large');
      throw error;
    }
    const check = verifySignature(raw, req.headers[SIGNATURE_HEADER], opts.appSecret);
    if (!check.ok) {
      log.warn('rejected webhook with bad signature', { reason: check.reason });
      return send(res, check.reason === 'missing' ? 401 : 403, 'invalid signature');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, 'invalid JSON');
    }
    const parsed = parseLeadgenEvents(payload);
    log.info('webhook received', { object: parsed.object, leads: parsed.events.length, ignored: parsed.ignored });

    if ((opts.ackMode ?? 'immediate') === 'after-processing') {
      const results: ProcessResult[] = [];
      for (const event of parsed.events) results.push(await opts.processor.process(event));
      const failed = results.filter((r) => !OK_STATUSES.has(r.status));
      // A non-200 answer makes Meta retry the notification later.
      return failed.length ? send(res, 500, 'delivery failed') : send(res, 200, 'EVENT_RECEIVED');
    }
    for (const event of parsed.events) {
      if (!opts.queue.push(event)) {
        log.error('queue full, asking Meta to retry', { leadgenId: event.leadgenId });
        return send(res, 503, 'busy');
      }
    }
    return send(res, 200, 'EVENT_RECEIVED');
  }

  async function admin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!opts.adminToken) return send(res, 404, 'not found');
    if (!authorized(req)) return send(res, 401, 'unauthorized');
    if (req.method === 'GET' && url.pathname === '/admin/stats') {
      return send(res, 200, { store: await opts.store.stats(), queue: { size: opts.queue.size, active: opts.queue.active } });
    }
    const m = /^\/admin\/leads\/(\d{1,32})(\/replay)?$/.exec(url.pathname);
    if (m) {
      const id = m[1]!;
      if (req.method === 'GET' && !m[2]) {
        const record = await opts.store.get(id);
        return record ? send(res, 200, record) : send(res, 404, 'not found');
      }
      if (req.method === 'POST' && m[2]) {
        if (url.searchParams.get('force') === '1') await opts.store.delete(id);
        const record = await opts.store.get(id);
        const event: LeadgenEvent = { leadgenId: id, pageId: url.searchParams.get('page_id') ?? record?.pageId ?? '' };
        const formId = url.searchParams.get('form_id') ?? record?.formId;
        if (formId) event.formId = formId;
        const result = await opts.processor.process(event);
        return send(res, OK_STATUSES.has(result.status) ? 200 : 502, result);
      }
    }
    return send(res, 404, 'not found');
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === path) {
        if (req.method === 'GET') {
          const v = handleVerification(url.searchParams, opts.verifyToken);
          if (!v.ok) {
            log.warn('webhook verification failed', { reason: v.reason });
            return send(res, v.status, v.reason);
          }
          log.info('webhook verified');
          return send(res, 200, v.challenge);
        }
        if (req.method === 'POST') return await webhookPost(req, res);
        res.setHeader('Allow', 'GET, POST');
        return send(res, 405, 'method not allowed');
      }
      if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        return send(res, 200, { status: 'ok' });
      }
      if (url.pathname.startsWith('/admin/')) return await admin(req, res, url);
      return send(res, 404, 'not found');
    } catch (error) {
      log.error('request failed', { error: (error as Error).message });
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.end();
    }
  };
}

export function createHttpServer(opts: HandlerOptions): Server {
  const handler = createHandler(opts);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  // Slow-loris protection; Meta sends small bodies quickly.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}
