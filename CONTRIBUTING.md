# Contributing

Thanks for taking the time to improve meta-lead-ads-sync. Bug reports, new
sinks, mapping transforms and documentation fixes are all welcome.

## Reporting a bug

Open an issue with:

- what you expected and what happened, with the JSON log lines around it
- your Node.js version (`node --version`), how you run the service (Docker,
  plain Node.js) and the store type
- your config with every secret replaced by a placeholder
- for mapping problems: the `field_data` of a test lead (use Meta's Lead Ads
  Testing Tool, not a real person's data)

Never post App Secrets, access tokens, service account keys or bot tokens.

## Development setup

You need Node.js 20 or newer (22.13+ to run the SQLite tests).

```bash
git clone https://github.com/saizul/meta-lead-ads-sync.git
cd meta-lead-ads-sync
npm ci
npm run lint
npm test
```

`npm test` compiles `src/` and `test/` into `dist/` and runs
`node --test dist/test/*.test.js`. CI runs it on Node.js 20, 22 and 24.

## Guidelines

- **No runtime dependencies.** Use Node.js built-ins. Development tools go in
  `devDependencies`.
- **Tests never touch the network.** Inject `MockFetch` from
  `test/helpers/mock-fetch.ts` and `noSleep` for retries. The HTTP server tests
  listen on a random local port.
- **Follow the official documentation.** Changes to webhook handling, Graph API
  calls, Sheets or Telegram requests should link the Meta, Google or Telegram
  page that documents the behaviour.
- **No personal data in fixtures.** Use made-up names, `example.com` addresses
  and obviously fake ids.
- **Every change comes with a test** that fails without it.
- Add a line to the `Unreleased` section of `CHANGELOG.md` for anything a user
  would notice.

## Project layout

```text
src/
  server.ts        HTTP routes: verification, webhook, health, admin
  webhook.ts       hub.challenge handling and leadgen parsing
  signature.ts     X-Hub-Signature-256, appsecret_proof, constant-time compare
  graph.ts         Graph API lead client with retries
  processor.ts     claim, fetch, map, deliver, record
  queue.ts         in-process work queue
  mapping.ts       field mapping and transforms
  phone-bd.ts      Bangladeshi phone normalisation
  google-auth.ts   service account JWT and token cache
  sinks/           google-sheets, webhook, telegram
  store/           memory, json-file, sqlite
  config.ts        config loading and validation
  app.ts           wiring
  cli.ts           command-line interface
test/              node:test suites and helpers
examples/          configs, sample payloads, scripts
deploy/            Docker Compose and Caddyfile
```

## Adding a sink

Implement the `Sink` interface in `src/sinks/`, throw `SinkError` with
`retryable` set correctly, add its config type and validation to
`src/config.ts`, construct it in `buildSinks()` in `src/app.ts`, export it from
`src/sinks/index.ts`, and document it in the README.

## Pull requests

Keep pull requests focused on one change, describe what it does and why, and
mention anything you could not test. By contributing you agree that your work
is released under the MIT license of this project.
