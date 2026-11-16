#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp, type AppDeps } from './app.js';
import { loadConfig } from './config.js';
import { LeadSyncError } from './errors.js';
import { FieldMapper } from './mapping.js';
import { SinkRoute } from './routing.js';
import type { Lead, LeadgenEvent } from './types.js';
import { parseBdPhone } from './phone-bd.js';
import { signPayload } from './signature.js';
import { VERSION } from './version.js';

const HELP = `meta-lead-ads-sync ${VERSION}

Usage:
  meta-lead-ads-sync serve [--config FILE]           run the webhook server
  meta-lead-ads-sync check-config [--config FILE]    validate the config and list sinks
  meta-lead-ads-sync replay LEADGEN_ID [--page-id ID] [--form-id ID] [--force] [--config FILE]
                                                     fetch and deliver one lead now
  meta-lead-ads-sync retry [--config FILE]           retry failed and partial leads once
  meta-lead-ads-sync route LEAD_FILE [--page-id ID] [--form-id ID] [--config FILE]
                                                     show which sinks a lead (Graph API JSON)
                                                     would go to, offline
  meta-lead-ads-sync sign FILE                       print X-Hub-Signature-256 for a body
                                                     (secret from META_APP_SECRET)
  meta-lead-ads-sync phone NUMBER...                 normalise Bangladeshi phone numbers

Options:
  -c, --config FILE   config file (default: $CONFIG_PATH or ./config.json)
  -h, --help          show this help
  -v, --version       show the version

Exit codes: 0 ok, 1 runtime or delivery failure, 2 usage or configuration error.
`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  deps?: AppDeps;
  /** Called by `serve` with a function that stops the server (tests use it instead of signals). */
  onServe?: (stop: () => Promise<void>) => void;
}

const defaultIo: CliIo = {
  out: (l) => process.stdout.write(l + '\n'),
  err: (l) => process.stderr.write(l + '\n'),
  env: process.env,
};

export async function run(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        'page-id': { type: 'string' },
        'form-id': { type: 'string' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(VERSION);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.out(HELP);
    return command || values.help ? 0 : 2;
  }
  const configPath = values.config ?? io.env.CONFIG_PATH ?? './config.json';

  try {
    switch (command) {
      case 'phone': {
        if (rest.length === 0) {
          io.err('phone: give at least one number');
          return 2;
        }
        let bad = 0;
        for (const n of rest) {
          const r = parseBdPhone(n);
          if (r.valid) io.out(`${n}\t${r.e164}\t${r.national}\t${r.operator}`);
          else {
            bad++;
            io.out(`${n}\tinvalid\t${r.reason}`);
          }
        }
        return bad ? 1 : 0;
      }
      case 'sign': {
        const secret = io.env.META_APP_SECRET;
        if (!rest[0] || !secret) {
          io.err('sign: usage `META_APP_SECRET=... meta-lead-ads-sync sign body.json`');
          return 2;
        }
        io.out(signPayload(await readFile(rest[0]), secret));
        return 0;
      }
      case 'check-config': {
        const config = await loadConfig(configPath, io.env);
        io.out(`config ok: ${configPath}`);
        io.out(`  webhook: ${config.server.host}:${config.server.port}${config.server.webhookPath} (ack ${config.server.ackMode})`);
        io.out(`  graph:   ${config.meta.graphVersion}, appsecret_proof ${config.meta.appSecretProof ? 'on' : 'off'}`);
        io.out(`  store:   ${config.store.type}${config.store.path ? ` (${config.store.path})` : ''}`);
        io.out(`  mapping: ${config.mapping.columns.map((c) => c.name).join(', ')}`);
        for (const s of config.sinks) {
          io.out(`  sink:    ${s.name ?? s.type} [${s.type}]${s.enabled === false ? ' (disabled)' : ''}${s.when ? ' (routed)' : ''}`);
        }
        if (config.sinks.length === 0) io.out('  sink:    none');
        return 0;
      }
      case 'serve': {
        const config = await loadConfig(configPath, io.env);
        const app = await createApp(config, io.deps);
        await app.listen();
        let stopping: Promise<void> | undefined;
        const stop = () => {
          stopping ??= app.close().then(() => app.logger.info('stopped'));
          return stopping;
        };
        if (io.onServe) io.onServe(stop);
        else {
          for (const sig of ['SIGINT', 'SIGTERM'] as const) {
            process.once(sig, () => {
              app.logger.info('shutting down', { signal: sig });
              void stop().then(() => process.exit(0));
            });
          }
        }
        return 0;
      }
      case 'replay': {
        const id = rest[0];
        if (!id || !/^\d+$/.test(id)) {
          io.err('replay: give a numeric leadgen id');
          return 2;
        }
        const config = await loadConfig(configPath, io.env);
        const app = await createApp({ ...config, logLevel: 'warn' }, io.deps);
        try {
          if (values.force) await app.store.delete(id);
          const record = await app.store.get(id);
          const event: { leadgenId: string; pageId: string; formId?: string } = {
            leadgenId: id,
            pageId: values['page-id'] ?? record?.pageId ?? '',
          };
          const formId = values['form-id'] ?? record?.formId;
          if (formId) event.formId = formId;
          const result = await app.processor.process(event);
          io.out(JSON.stringify(result, null, 2));
          return ['done', 'duplicate', 'skipped'].includes(result.status) ? 0 : 1;
        } finally {
          await app.store.close();
        }
      }
      case 'route': {
        if (!rest[0]) {
          io.err('route: give a lead JSON file (the Graph API response for one lead)');
          return 2;
        }
        const config = await loadConfig(configPath, io.env);
        let lead: Lead;
        try {
          lead = JSON.parse(await readFile(rest[0], 'utf8')) as Lead;
        } catch (error) {
          io.err(`route: cannot read ${rest[0]}: ${(error as Error).message}`);
          return 2;
        }
        if (!lead || typeof lead !== 'object' || typeof lead.id !== 'string') {
          io.err('route: the lead file needs at least an "id"');
          return 2;
        }
        const event: LeadgenEvent = { leadgenId: lead.id, pageId: values['page-id'] ?? '' };
        const formId = values['form-id'] ?? lead.form_id;
        if (formId) event.formId = formId;
        const spec = (formId && config.formMappings[formId]) || config.mapping;
        const mapped = new FieldMapper(spec).map(lead, event);
        const ctx = { event, lead, mapped };
        let routed = 0;
        for (const s of config.sinks) {
          const name = s.name ?? s.type;
          if (s.enabled === false) {
            io.out(`${name}\tdisabled`);
            continue;
          }
          const decision = s.when ? new SinkRoute(s.when, `${name}.when`).evaluate(ctx) : { matched: true, reason: '' };
          if (decision.matched) routed++;
          io.out(decision.matched ? `${name}\tdeliver` : `${name}\tskip\t${decision.reason}`);
        }
        io.out(`${routed} sink(s) would get lead ${lead.id}`);
        return 0;
      }
      case 'retry': {
        const config = await loadConfig(configPath, io.env);
        const app = await createApp({ ...config, logLevel: 'warn' }, io.deps);
        try {
          const results = await app.processor.retryPending({ maxAttempts: config.processing.maxAttempts });
          for (const r of results) io.out(`${r.leadgenId}\t${r.status}`);
          io.out(`${results.length} lead(s) retried`);
          return results.every((r) => ['done', 'duplicate', 'skipped'].includes(r.status)) ? 0 : 1;
        } finally {
          await app.store.close();
        }
      }
      default:
        io.err(`unknown command "${command}"\n`);
        io.err(HELP);
        return 2;
    }
  } catch (error) {
    io.err(`error: ${(error as Error).message}`);
    return error instanceof LeadSyncError && error.name === 'ConfigError' ? 2 : 1;
  }
}

// Run when executed directly or through the npm bin link, not when imported by tests.
function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${(error as Error).stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
