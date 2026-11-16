# meta-lead-ads-sync

[![CI](https://github.com/saizul/meta-lead-ads-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/meta-lead-ads-sync/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-20%2B-blue)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A small, self-hosted webhook service for **Facebook and Instagram Lead Ads**. When someone submits a lead form, Meta
notifies the service; it checks the `X-Hub-Signature-256` signature, fetches the answers from the Graph API, cleans
them up (including Bangladeshi phone numbers), skips anything it has already handled, and delivers the lead to
**Google Sheets**, **n8n or any webhook**, and **Telegram**.

```text
Meta ──POST /webhook──▶ verify HMAC ──▶ 200 ──▶ queue ──▶ GET /{leadgen_id} ──▶ map fields ──▶ Google Sheets
     (leadgen change)    (raw body)              │        (Graph API, retries)   phone_bd       n8n / webhook
                                                 └── idempotency store (JSON or SQLite) ──────▶ Telegram
```

It is a Node.js 20+ service and TypeScript library with **no runtime dependencies**: `node:http`, `node:crypto` and
the built-in `fetch`. Google's service-account JWT is signed with `node:crypto`; SQLite uses the built-in
`node:sqlite` when your Node.js has it.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Install](#install)
- [Install from GitHub Packages](#install-from-github-packages)
- [Meta setup](#meta-setup)
- [Usage](#usage)
- [Configuration](#configuration)
- [Field mapping](#field-mapping)
- [Sinks](#sinks)
- [Routing leads to sinks](#routing-leads-to-sinks)
- [Deployment with Docker and Caddy](#deployment-with-docker-and-caddy)
- [Admin endpoints](#admin-endpoints)
- [Library use](#library-use)
- [Examples](#examples)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Webhook handling**
  - `GET` verification: answers `hub.challenge` when `hub.mode=subscribe` and `hub.verify_token` matches
    (constant-time compare; a challenge that is not a plain token is refused, so nothing is reflected)
  - `POST` notifications: `X-Hub-Signature-256` HMAC-SHA256 checked over the **raw body bytes** before any JSON
    parsing, constant-time; body size limit; batched entries and changes; other subscribed fields ignored
  - answers `200` straight away and processes in the background (`ackMode: immediate`), or only after delivery so
    Meta retries failures (`ackMode: after-processing`)
- **Graph API**: `GET /{leadgen_id}?fields=...` with a Page access token in the `Authorization` header (never in the
  URL), `appsecret_proof`, per-Page tokens, configurable API version and fields, and retries with exponential backoff
  and jitter on network errors, 5xx, `is_transient` and the rate-limit error codes (4, 17, 32, 341, 613, 80000-80014).
  Token and permission errors are not retried.
- **Idempotency**: every `leadgen_id` is claimed in a store before it is fetched. Meta's retries and duplicate
  notifications are skipped, concurrent duplicates are processed once, and when one sink fails only that sink is
  retried later; the Google Sheet never gets the same row twice. JSON file store (default) or SQLite
  (`node:sqlite`, Node.js 22.13+), with retention pruning.
- **Retry sweep**: failed and partly delivered leads are retried every few minutes, up to a maximum number of attempts.
- **Sinks**
  - **Google Sheets**: service account JWT (RS256) exchanged for an access token and cached, `values.append` with
    `RAW` or `USER_ENTERED`, an automatic header row, fixed column order, formula-injection escaping
  - **Webhook / n8n**: JSON POST with an `Idempotency-Key` header and an optional `X-Signature-256` HMAC so the
    receiver can check it came from you
  - **Telegram**: Bot API `sendMessage` in HTML mode with a template, forum topics, `retry_after` honoured on 429
- **Routing**: a `when` rule per sink sends it only the leads it should get, by form, Page, organic or paid,
  platform and conditions on answers or mapped columns (`equals`, `notEquals`, `matches`, `exists`), with `all`,
  `any` and `none`. `route` shows offline which sinks a lead would go to and why.
- **Field mapping** from a config file: form answers, lead and webhook properties, constants, fallbacks, defaults,
  per-form mappings and transforms (`phone_bd`, `datetime:Asia/Dhaka`, `lower`, `trim`, ...).
- **Bangladeshi phone normalisation**: `01712-345678`, `+880 1712 345678`, `8801712345678`, `00880...`,
  `+88001712345678`, `1712345678` and Bangla digits (`০১৭১২৩৪৫৬৭৮`) all become `+8801712345678`, with the operator.
  Foreign numbers are kept as entered.
- **Operations**: JSON logs with secrets redacted, `/healthz`, token-protected `/admin` endpoints (stats, lookup,
  replay), graceful shutdown, a CLI (`serve`, `check-config`, `replay`, `retry`, `sign`, `phone`), Dockerfile and a
  Docker Compose example with Caddy for automatic HTTPS.
- **Testable**: `fetch`, `sleep`, clock, logger and store are injectable.

## How it works

1. Meta sends `POST /webhook` with a `leadgen` change: `leadgen_id`, `page_id`, `form_id`, `ad_id`, `adgroup_id` and
   `created_time`. The notification carries **no answers**, only the id.
2. The signature is checked against the raw body with your App Secret. Invalid requests get `401`/`403`.
3. Each `leadgen_id` is queued and the request is answered with `200 EVENT_RECEIVED`. Meta retries unacknowledged
   notifications for up to 36 hours, so answering quickly matters.
4. A worker claims the id in the store (duplicates stop here), fetches `GET /v27.0/{leadgen_id}` and maps
   `field_data` to columns.
5. Each sink that does not yet have the lead gets it, with retries. The store records which sinks succeeded.
6. Leads that failed (Graph error, sink down) are retried by the sweep, without resending to sinks that already have
   them.

## Install

```bash
git clone https://github.com/saizul/meta-lead-ads-sync.git
cd meta-lead-ads-sync
npm ci
npm run build
cp examples/config.example.json config.json   # edit to taste
cp .env.example .env                           # fill in your secrets
set -a; . ./.env; set +a
node dist/src/cli.js check-config --config config.json
node dist/src/cli.js serve --config config.json
```

The project is not on the npm registry yet; for production use Docker (below) or install from GitHub Packages.

## Install from GitHub Packages

Every release is also published to GitHub Packages as `@saizul/meta-lead-ads-sync`.

1. Create a GitHub personal access token (classic) with the `read:packages` scope.
2. Add an `.npmrc` next to your `package.json`:

   ```ini
   @saizul:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

3. Install with the token in your environment:

   ```bash
   export GITHUB_TOKEN=ghp_your_token_here
   npm install @saizul/meta-lead-ads-sync
   ```

4. Run the bundled CLI, or import the scoped name:

   ```bash
   npx meta-lead-ads-sync serve --config config.json
   ```

   ```ts
   import { verifySignature, parseLeadgenEvents, normalizeBdPhone } from '@saizul/meta-lead-ads-sync';
   ```

In GitHub Actions, use `secrets.GITHUB_TOKEN` with `permissions: packages: read`.

## Meta setup

1. **App**: in the [Meta App Dashboard](https://developers.facebook.com/apps/) create (or pick) a Business app and add
   the **Webhooks** product. Copy the **App Secret** (App settings > Basic) into `META_APP_SECRET`.
2. **Callback**: subscribe the **Page** object to the `leadgen` field with callback URL
   `https://leads.example.com/webhook` and a verify token of your choice (`META_VERIFY_TOKEN`). The service must be
   running and reachable over HTTPS for the verification request to succeed.
3. **Page subscription**: subscribe your app to the Page, for example with
   `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen` using a Page access token.
4. **Token**: create a long-lived Page access token (a System User token in Business Manager is the most durable) from
   someone who can advertise on the Page, with `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`,
   `pages_read_engagement` and `ads_management`. Put it in `META_PAGE_ACCESS_TOKEN`, or in `meta.pageTokens` per Page.
5. **CRM access**: in the Page's Leads Access settings, make sure your app is allowed to read leads.
6. **Test**: Meta's Lead Ads Testing Tool creates a test lead for a form; it should show up in your sinks within
   seconds.

## Usage

```console
$ meta-lead-ads-sync serve --config config.json             # run the webhook server
$ meta-lead-ads-sync check-config --config config.json      # validate, list sinks (no secrets printed)
$ meta-lead-ads-sync replay 900000000000001 --page-id 111111111111111   # fetch and deliver one lead now
$ meta-lead-ads-sync replay 900000000000001 --force         # forget it first, deliver again to every sink
$ meta-lead-ads-sync retry                                  # one retry sweep of failed/partial leads
$ meta-lead-ads-sync route examples/sample-lead.json        # which sinks would get this lead, and why not (offline)
$ META_APP_SECRET=... meta-lead-ads-sync sign body.json     # X-Hub-Signature-256 for a test request
$ meta-lead-ads-sync phone 01712-345678 "+880 1812 345678" ০১৯১২৩৪৫৬৭৮
01712-345678      +8801712345678  01712345678  Grameenphone
+880 1812 345678  +8801812345678  01812345678  Robi
০১৯১২৩৪৫৬৭৮       +8801912345678  01912345678  Banglalink
```

The config path defaults to `$CONFIG_PATH`, then `./config.json`. Exit codes: `0` ok, `1` runtime or delivery
failure, `2` usage or configuration error.

`replay` and `retry` open the store directly. With the JSON store, run them only while the server is stopped (or use
the [admin endpoints](#admin-endpoints) of the running server); the SQLite store is safe to share.

## Configuration

The config is a JSON file. Any string can reference environment variables as `${NAME}` or `${NAME:-default}`; an
unset variable without a default stops start-up with a clear error. Keep secrets in the environment, not in the file.
`PORT` overrides the port when the file does not set one.

| Key | Default | Meaning |
| --- | --- | --- |
| `server.host` / `server.port` | `0.0.0.0` / `8080` | listen address |
| `server.webhookPath` | `/webhook` | callback path |
| `server.maxBodyBytes` | `1048576` | larger bodies get `413` |
| `server.ackMode` | `immediate` | `immediate` or `after-processing` (see [How it works](#how-it-works)) |
| `server.adminToken` | none | enables `/admin/*` with this bearer token (16+ characters) |
| `meta.appSecret` | required | App Secret, for signatures and `appsecret_proof` |
| `meta.verifyToken` | required | the verify token entered in the App Dashboard (8+ characters) |
| `meta.accessToken` | | Page access token for every Page |
| `meta.pageTokens` | `{}` | `{ "<page id>": "<token>" }` for several Pages |
| `meta.graphVersion` | `v27.0` | Graph API version |
| `meta.fields` | `id,created_time,ad_id,form_id,field_data` | lead fields to request |
| `meta.appSecretProof` | `true` | send `appsecret_proof` (required if "Require App Secret" is on) |
| `meta.pageIds` / `meta.formIds` | all | only process these Pages / forms |
| `store.type` / `store.path` | `json` / `./data/leads.json` | `json`, `sqlite` or `memory` |
| `store.retentionDays` | `90` | forget handled leads after this many days (`0` keeps them) |
| `mapping` | built-in | see [Field mapping](#field-mapping) |
| `formMappings` | `{}` | `{ "<form id>": <mapping> }` |
| `sinks` | `[]` | see [Sinks](#sinks); each takes `name`, `enabled` and `when` ([routing](#routing-leads-to-sinks)) |
| `processing.concurrency` | `2` | leads processed in parallel |
| `processing.retryIntervalSeconds` | `300` | retry sweep interval, `0` disables |
| `processing.maxAttempts` | `8` | attempts per lead before giving up |
| `processing.sinkRetryAttempts` | `3` | attempts per sink within one attempt |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error` or `silent` |

To request more lead properties, add them to `meta.fields`, for example
`["id", "created_time", "ad_id", "ad_name", "adset_name", "campaign_name", "form_id", "is_organic", "field_data"]`.
Ad-level fields need the ads permissions listed above.

See [examples/config.example.json](examples/config.example.json) for a complete file and
[examples/config.minimal.json](examples/config.minimal.json) for the smallest useful one.

## Field mapping

A mapping turns a lead into named columns, in a fixed order:

```json
{
  "columns": [
    { "name": "Lead ID", "from": "lead.id" },
    { "name": "Received (Dhaka)", "from": ["lead.created_time", "event.created_time"], "transform": ["datetime:Asia/Dhaka"] },
    { "name": "Name", "from": ["field.full_name", "field.first_name"] },
    { "name": "Phone", "from": "field.phone_number", "transform": ["phone_bd"] },
    { "name": "Email", "from": "field.email", "transform": ["trim", "lower"] },
    { "name": "City", "from": "field.city", "default": "not given" },
    { "name": "Source", "value": "Facebook Lead Ads" }
  ],
  "includeUnmapped": true,
  "joinWith": ", "
}
```

Sources:

| Source | Value |
| --- | --- |
| `field.<name>` | a form answer from `field_data` (standard questions use names such as `full_name`, `email`, `phone_number`, `city`; custom questions use the key shown in the form) |
| `lead.<key>` | a lead property from the Graph API (`id`, `created_time`, `ad_id`, `form_id`, anything in `meta.fields`) |
| `event.<key>` | a webhook value: `leadgen_id`, `page_id`, `form_id`, `ad_id`, `adgroup_id`, `created_time` |
| `value` | a constant |

`from` can be a list: the first non-empty source wins. Answers with several values are joined with `joinWith`. With
`includeUnmapped`, answers no column used are kept as "extra" data: the webhook sink sends them, Telegram lists them,
and the Sheets sink can put them in a last JSON column.

Transforms run in order:

| Transform | Effect |
| --- | --- |
| `trim`, `lower`, `upper`, `collapse_spaces`, `digits` | text clean-up |
| `phone_bd`, `phone_bd:national`, `phone_bd:digits` | `+8801712345678`, `01712345678`, `8801712345678`; non-Bangladeshi numbers unchanged |
| `datetime` | ISO 8601 UTC |
| `datetime:Asia/Dhaka` | `YYYY-MM-DD HH:mm:ss` in that time zone |
| `prefix:TEXT`, `truncate:N` | add a prefix / cut to N characters |

Mapping mistakes (unknown transform, bad source, duplicate column) are caught when the config is loaded.

## Sinks

### Google Sheets

```json
{
  "type": "google_sheets",
  "name": "sheet",
  "spreadsheetId": "${GOOGLE_SPREADSHEET_ID}",
  "range": "Leads!A1",
  "credentialsFile": "/run/secrets/google-service-account.json",
  "valueInputOption": "RAW",
  "extraColumn": true
}
```

1. In Google Cloud, enable the Google Sheets API, create a service account and download a JSON key.
2. Share the spreadsheet with the service account's `client_email` as **Editor**.
3. Point `credentialsFile` at the key, or pass its contents in `credentialsJson` (for example
   `"credentialsJson": "${GOOGLE_SERVICE_ACCOUNT_JSON}"`).

Rows are added with `POST /v4/spreadsheets/{id}/values/{range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`.
On the first lead after start-up the first row is read; when it is empty a header row with the column names is
written. `RAW` stores values exactly (so `+880...` stays text); with `USER_ENTERED` values that start with `=`, `+`,
`-` or `@` are prefixed with `'` so form answers can never run as formulas. `columns` picks and orders the columns for
this sheet. The access token is cached for its lifetime (one hour) and refreshed on `401`.

### Webhook (n8n, Make, Zapier, your CRM)

```json
{ "type": "webhook", "name": "n8n", "url": "${N8N_WEBHOOK_URL}", "secret": "${N8N_WEBHOOK_SECRET}", "headers": { "X-Api-Key": "${CRM_KEY}" } }
```

Body:

```json
{
  "event": "lead.created",
  "leadgen_id": "900000000000001",
  "page_id": "111111111111111",
  "form_id": "222222222222222",
  "created_time": "2026-11-13T05:00:00+0000",
  "lead": { "Name": "Rahim Uddin", "Phone": "+8801712345678" },
  "extra": { "which_service?": "SEO" },
  "raw": { "lead": { "...": "Graph API response" }, "event": { "...": "webhook values" } }
}
```

Headers: `Idempotency-Key: <leadgen_id>`, and with `secret`, `X-Signature-256: sha256=<HMAC-SHA256 of the body>`.
[examples/n8n-verify-signature.js](examples/n8n-verify-signature.js) checks it in an n8n Code node. Set
`"includeRaw": false` to send only the mapped values. 5xx, 408, 425, 429 and network errors are retried; other 4xx
are not.

### Telegram

```json
{
  "type": "telegram",
  "botToken": "${TELEGRAM_BOT_TOKEN}",
  "chatId": "${TELEGRAM_CHAT_ID}",
  "template": "<b>New lead</b>\nName: {{Name}}\nPhone: {{Phone}}",
  "messageThreadId": 12
}
```

Create a bot with @BotFather and add it to the group or channel. `{{Column}}` inserts a mapped value (HTML-escaped),
`{{#all}}` every non-empty column. The default template is `<b>New lead</b>` followed by `{{#all}}`. On `429` the
`retry_after` value is respected.

## Routing leads to sinks

By default every sink gets every lead. Add `when` to a sink to send it only the leads that match:

```json
{
  "type": "telegram",
  "name": "dhaka-sales",
  "botToken": "${TELEGRAM_BOT_TOKEN}",
  "chatId": "${TELEGRAM_DHAKA_CHAT_ID}",
  "when": {
    "forms": ["222222222222222"],
    "organic": false,
    "all": [{ "from": "column.City", "equals": ["Dhaka", "Gazipur", "Narayanganj"] }],
    "any": [{ "from": "field.budget", "matches": "lakh|50k" }, { "from": "field.company_name", "exists": true }],
    "none": [{ "from": "column.Email", "matches": "@(example|test)\\.(com|org)$" }]
  }
}
```

| Key | Matches when |
| --- | --- |
| `forms` / `pages` | the lead's form id / Page id is in the list (array or comma-separated string) |
| `organic` | `lead.is_organic` is this value (`false`: leads from ads); add `is_organic` to `meta.fields` |
| `platforms` | `lead.platform` is one of these (`fb`, `ig`); add `platform` to `meta.fields` |
| `all` | every condition holds |
| `any` | at least one condition holds |
| `none` | no condition holds |

Every key that is present must match. A condition reads one value with `from` (`field.<name>`, `lead.<key>`,
`event.<key>`, or `column.<name>` for a mapped column after its transforms, so `column.Phone` is already
`+880...`) and tests it with `equals` (a value or a list), `notEquals`, `matches` (a regular expression) and/or
`exists` (`true`: not empty, `false`: empty). Tests in one condition must all hold. Comparisons ignore case and
surrounding spaces. Mistakes (unknown keys, bad sources, invalid regular expressions) stop start-up.

A lead that a rule leaves out is not an error: the lead is `done` once every sink it was routed to has it, and the
processing result lists the other sinks under `routedAway` with the reason. Rules are checked again on retries, but a
sink that already has a lead is never asked to drop it. Check a rule before deploying with `route`, which maps a lead
file (a Graph API response, like [examples/sample-lead.json](examples/sample-lead.json)) and prints one line per
sink without network access:

```console
$ meta-lead-ads-sync route examples/sample-lead.json --config examples/config.example.json
sheet     deliver
n8n       deliver
telegram  skip  none: column.Email matches /@(example|test)\.(com|org)$/ matched
2 sink(s) would get lead 900000000000001
```

`--form-id` and `--page-id` stand in for the webhook values when the file has no `form_id` or the rule uses `pages`.

## Deployment with Docker and Caddy

[deploy/docker-compose.yml](deploy/docker-compose.yml) runs the service behind [Caddy](https://caddyserver.com/),
which gets and renews a Let's Encrypt certificate on its own. Meta only calls HTTPS endpoints.

```bash
cd deploy
cp .env.example .env                                  # secrets + LEADS_DOMAIN=leads.example.com
cp ../examples/config.example.json config.json
mkdir -p secrets && cp ~/Downloads/service-account.json secrets/google-service-account.json
docker compose up -d --build
docker compose logs -f lead-sync
```

Point a DNS record for `LEADS_DOMAIN` at the server and open ports 80 and 443, then use
`https://leads.example.com/webhook` as the callback URL. The container runs as the unprivileged `node` user with a
read-only root file system; the store lives in the `lead-data` volume. The Caddyfile limits request bodies to 1 MB and
does not expose `/admin/*` to the internet.

Without Compose:

```bash
docker build -t meta-lead-ads-sync .
docker run -d --name lead-sync -p 127.0.0.1:8080:8080 --env-file .env \
  -v "$PWD/config.json:/app/config/config.json:ro" -v lead-data:/app/data meta-lead-ads-sync
```

Any reverse proxy with TLS works (nginx, Traefik, a cloud load balancer). Run a single instance with the JSON store;
for several instances use the SQLite store on shared storage only if the file system supports locking, or put a
queue in front.

## Admin endpoints

Enabled only when `server.adminToken` is set. Send `Authorization: Bearer <token>`.

| Method and path | Purpose |
| --- | --- |
| `GET /admin/stats` | lead counts by status, queue size |
| `GET /admin/leads/{leadgen_id}` | the stored delivery record |
| `POST /admin/leads/{leadgen_id}/replay` | process again (duplicates are skipped); `?force=1` forgets it first, `?page_id=` / `?form_id=` set the event |

```bash
docker compose exec lead-sync wget -qO- --header "Authorization: Bearer $ADMIN_TOKEN" \
  --post-data '' "http://127.0.0.1:8080/admin/leads/900000000000001/replay?force=1"
```

`GET /healthz` answers `{"status":"ok"}` without authentication.

## Library use

Every part is exported, so you can use them inside your own Express, Fastify or serverless handler:

```ts
import {
  FieldMapper, GraphClient, LeadProcessor, SqliteStore, WebhookSink,
  parseLeadgenEvents, verifySignature,
} from '@saizul/meta-lead-ads-sync';

const processor = new LeadProcessor({
  graph: new GraphClient({ accessToken: process.env.META_PAGE_ACCESS_TOKEN!, appSecret: process.env.META_APP_SECRET }),
  store: await SqliteStore.open('./data/leads.sqlite'),
  mapper: new FieldMapper(),
  sinks: [new WebhookSink({ url: 'https://n8n.example.com/webhook/leads' })],
});

// rawBody must be the unparsed request body (Buffer).
if (!verifySignature(rawBody, req.headers['x-hub-signature-256'], process.env.META_APP_SECRET!).ok) return reply(403);
for (const event of parseLeadgenEvents(JSON.parse(rawBody.toString())).events) await processor.process(event);
```

A sink is any object with `name`, `type` and `async send({ event, lead, mapped })`; throw a `SinkError` with
`retryable: true` for temporary failures. `createHandler()` gives you the request handler without a server, and every
class takes a `fetch` option, so tests never need the network.

## Examples

- [examples/config.example.json](examples/config.example.json): all three sinks, Dhaka time, phone normalisation
- [examples/config.minimal.json](examples/config.minimal.json): one n8n webhook
- [examples/sample-webhook.json](examples/sample-webhook.json) and [sample-lead.json](examples/sample-lead.json):
  what Meta sends and what the Graph API returns
- [examples/send-test-webhook.mjs](examples/send-test-webhook.mjs): sign and send a notification to your server
- [examples/library-usage.mjs](examples/library-usage.mjs): the building blocks without the server
- [examples/n8n-verify-signature.js](examples/n8n-verify-signature.js): check the webhook sink signature in n8n
- [deploy/](deploy): Docker Compose and Caddyfile

## Testing

```bash
npm ci
npm run lint        # eslint + tsc --noEmit
npm test            # builds, then node --test dist/test/*.test.js
```

The suite covers signature checks (including the raw-versus-re-encoded body case), webhook parsing, Graph retries
and error classification, all stores (SQLite tests run when `node:sqlite` is available), the JWT (verified against
the public key of a throwaway RSA key), the Sheets, webhook and Telegram sinks, field mapping, phone normalisation,
the processor's partial-delivery logic, the config loader, the CLI, and the HTTP server end to end on a random local
port. External APIs are replaced by a scripted `fetch` ([test/helpers/mock-fetch.ts](test/helpers/mock-fetch.ts)).
CI runs it on Node.js 20, 22 and 24.

## Security notes

- **The signature is the authentication.** Requests without a valid `X-Hub-Signature-256` are rejected before the body
  is parsed. Keep the App Secret secret, and rotate it in the App Dashboard if it leaks.
- **Use HTTPS.** Meta requires it, and the body contains lead ids. The Compose example terminates TLS in Caddy.
- **Tokens stay out of URLs and logs.** The Graph token goes in the `Authorization` header, `appsecret_proof` ties
  calls to your app, and the logger redacts keys such as `token`, `secret` and `authorization` and access tokens in
  strings. Telegram errors never include the bot token URL.
- **Personal data.** Lead answers are not logged. They are kept only in your sinks; the store holds ids, statuses and
  sink names, and is pruned after `retentionDays`. The JSON store file is written with mode `0600`. Leads are personal
  data: follow your privacy policy and local law, and limit who can open the sheet and chat.
- **Spreadsheet formulas.** With `USER_ENTERED`, answers starting with `=`, `+`, `-` or `@` are escaped.
- **Admin endpoints** are off unless `adminToken` is set, compare the token in constant time, and are blocked in the
  example Caddyfile.
- **Service account keys** should be mounted read-only (as in the Compose file), never committed. `.gitignore` excludes
  `.env`, `secrets/` and `service-account*.json`.

Report security problems as described in [SECURITY.md](SECURITY.md).

## Limitations

- **One process per JSON store.** The JSON store keeps its data in memory and rewrites the file; two processes writing
  the same file lose updates. Use SQLite (`node:sqlite`, Node.js 22.13+) for the CLI next to a running server or for
  several workers.
- **Queue in memory.** With `ackMode: immediate`, a lead that was acknowledged but not yet claimed when the process is
  killed is lost from the queue (Meta will not resend it). Claimed leads are recovered by the retry sweep after
  10 minutes. Use `after-processing` if you prefer Meta's own retries, at the cost of slower responses.
- **No backfill.** Only leads notified while the service runs are handled. Leads from before the webhook was set up
  must be exported from Meta (or fetched from `/{form_id}/leads`, not implemented here) and replayed with
  `replay <leadgen_id>`.
- Meta keeps leads available through the API for a limited time; process failures before then.
- Only Bangladeshi mobile numbers are normalised. Landlines and other countries are stored as entered.
- Google Sheets limits: a sheet has a cell cap and the API has per-minute quotas; very high lead volumes need a
  database sink instead (use the webhook sink).
- The default Graph API version (`v27.0`) and field list are a snapshot; set `meta.graphVersion` and `meta.fields` to
  what your app uses.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) - Copyright (c) 2026 Saizul Amin
