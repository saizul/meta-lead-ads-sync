import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig, SinkConfig } from './config.js';
import { ConfigError } from './errors.js';
import { GoogleServiceAccountAuth, loadServiceAccount, parseServiceAccount } from './google-auth.js';
import { GraphClient } from './graph.js';
import { createJsonLogger, type Logger } from './logger.js';
import { FieldMapper } from './mapping.js';
import { LeadProcessor } from './processor.js';
import { WorkQueue } from './queue.js';
import { createHttpServer } from './server.js';
import { GoogleSheetsSink } from './sinks/google-sheets.js';
import { TelegramSink } from './sinks/telegram.js';
import type { Sink } from './sinks/types.js';
import { WebhookSink } from './sinks/webhook.js';
import { openStore, type IdempotencyStore } from './store/index.js';
import { defaultSleep, type FetchLike, type LeadgenEvent, type SleepFn } from './types.js';

export interface AppDeps {
  fetch?: FetchLike;
  logger?: Logger;
  store?: IdempotencyStore;
  sleep?: SleepFn;
  now?: () => number;
}

export interface App {
  config: AppConfig;
  processor: LeadProcessor;
  queue: WorkQueue<LeadgenEvent>;
  store: IdempotencyStore;
  sinks: Sink[];
  server: Server;
  logger: Logger;
  /** Listen on the configured host and port. Resolves with the bound port. */
  listen(): Promise<number>;
  /** Run one retry sweep now. */
  retryPending(): Promise<number>;
  /** Stop accepting requests, finish queued work and close the store. */
  close(): Promise<void>;
}

export async function buildSinks(configs: SinkConfig[], deps: AppDeps = {}): Promise<Sink[]> {
  const sinks: Sink[] = [];
  for (const c of configs) {
    if (c.enabled === false) continue;
    const common = deps.fetch ? { fetch: deps.fetch } : {};
    if (c.type === 'google_sheets') {
      const key = c.credentialsJson ? parseServiceAccount(c.credentialsJson) : await loadServiceAccount(c.credentialsFile!);
      const auth = new GoogleServiceAccountAuth({
        key,
        ...common,
        ...(c.subject ? { subject: c.subject } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      const opts: ConstructorParameters<typeof GoogleSheetsSink>[0] = { spreadsheetId: c.spreadsheetId, auth, ...common };
      if (c.name) opts.name = c.name;
      if (c.range) opts.range = c.range;
      if (c.valueInputOption) opts.valueInputOption = c.valueInputOption;
      if (c.insertDataOption) opts.insertDataOption = c.insertDataOption;
      if (c.columns) opts.columns = c.columns;
      if (c.extraColumn !== undefined) opts.extraColumn = c.extraColumn;
      if (c.headerRow !== undefined) opts.headerRow = c.headerRow;
      sinks.push(new GoogleSheetsSink(opts));
    } else if (c.type === 'webhook') {
      const opts: ConstructorParameters<typeof WebhookSink>[0] = { url: c.url, ...common };
      if (c.name) opts.name = c.name;
      if (c.secret) opts.secret = c.secret;
      if (c.headers) opts.headers = c.headers;
      if (c.includeRaw !== undefined) opts.includeRaw = c.includeRaw;
      if (c.timeoutMs !== undefined) opts.timeoutMs = c.timeoutMs;
      sinks.push(new WebhookSink(opts));
    } else {
      const opts: ConstructorParameters<typeof TelegramSink>[0] = { botToken: c.botToken, chatId: c.chatId, ...common };
      if (c.name) opts.name = c.name;
      if (c.template) opts.template = c.template;
      if (c.messageThreadId !== undefined) opts.messageThreadId = c.messageThreadId;
      if (c.disableNotification) opts.disableNotification = true;
      sinks.push(new TelegramSink(opts));
    }
  }
  return sinks;
}

/** Wire everything together from a validated config. Nothing listens until `listen()`. */
export async function createApp(config: AppConfig, deps: AppDeps = {}): Promise<App> {
  const logger = deps.logger ?? createJsonLogger({ level: config.logLevel });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const sinks = await buildSinks(config.sinks, deps);
  if (sinks.length === 0) logger.warn('no sinks enabled: leads are fetched and recorded but not delivered');

  const { accessToken, pageTokens } = config.meta;
  const graph = new GraphClient({
    accessToken: (pageId) => (pageId && pageTokens[pageId]) || accessToken,
    ...(config.meta.appSecretProof ? { appSecret: config.meta.appSecret } : {}),
    version: config.meta.graphVersion,
    ...(config.meta.fields ? { fields: config.meta.fields } : {}),
    retry: { attempts: 4, sleep },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    logger,
  });

  const formMappers: Record<string, FieldMapper> = {};
  for (const [form, spec] of Object.entries(config.formMappings)) formMappers[form] = new FieldMapper(spec);

  let store: IdempotencyStore;
  try {
    store = deps.store ?? (await openStore(config.store));
  } catch (error) {
    throw new ConfigError(`store: ${(error as Error).message}`, { cause: error });
  }

  const processor = new LeadProcessor({
    graph,
    store,
    sinks,
    mapper: new FieldMapper(config.mapping),
    formMappers,
    pageIds: config.meta.pageIds,
    formIds: config.meta.formIds,
    sinkRetry: { attempts: config.processing.sinkRetryAttempts, sleep },
    logger,
    now,
  });
  const queue = new WorkQueue<LeadgenEvent>(
    (event) => processor.process(event),
    config.processing.concurrency,
    (error, event) => logger.error('lead processing crashed', { leadgenId: event.leadgenId, error: (error as Error).message }),
  );
  const server = createHttpServer({
    appSecret: config.meta.appSecret,
    verifyToken: config.meta.verifyToken,
    webhookPath: config.server.webhookPath,
    maxBodyBytes: config.server.maxBodyBytes,
    ackMode: config.server.ackMode,
    ...(config.server.adminToken ? { adminToken: config.server.adminToken } : {}),
    processor,
    queue,
    store,
    logger,
  });

  let timer: NodeJS.Timeout | undefined;
  let sweeping = false;
  const retryPending = async (): Promise<number> => {
    if (sweeping) return 0;
    sweeping = true;
    try {
      const results = await processor.retryPending({ maxAttempts: config.processing.maxAttempts, limit: 100 });
      if (results.length) logger.info('retry sweep finished', { leads: results.length });
      if (config.store.retentionDays > 0) {
        const removed = await store.prune(now() - config.store.retentionDays * 86_400_000);
        if (removed) logger.info('pruned old lead records', { removed });
      }
      return results.length;
    } finally {
      sweeping = false;
    }
  };

  return {
    config,
    processor,
    queue,
    store,
    sinks,
    server,
    logger,
    retryPending,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.server.port, config.server.host, () => {
          server.off('error', reject);
          const port = (server.address() as AddressInfo).port;
          logger.info('listening', { host: config.server.host, port, webhookPath: config.server.webhookPath, sinks: sinks.map((s) => s.name) });
          if (config.processing.retryIntervalSeconds > 0) {
            timer = setInterval(() => {
              retryPending().catch((error) => logger.error('retry sweep failed', { error: (error as Error).message }));
            }, config.processing.retryIntervalSeconds * 1000);
            timer.unref();
          }
          resolve(port);
        });
      }),
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue.close();
      await store.close();
    },
  };
}
