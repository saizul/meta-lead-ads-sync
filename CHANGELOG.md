# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-sink routing: a `when` rule on any sink limits it to leads that match by form, Page, `is_organic`,
  `platform` and `all` / `any` / `none` conditions (`equals`, `notEquals`, `matches`, `exists`) on form answers,
  lead and webhook values or mapped columns. Rules are validated when the config is loaded.
- `route LEAD_FILE` command: shows offline which sinks a lead would be delivered to and why the others are skipped;
  `check-config` marks routed sinks.
- `routedAway` in processing results (CLI `replay`, admin replay), and the `SinkRoute` class in the library API.

## [0.1.0] - 2026-11-13

First public release.

### Added

- Webhook server on `node:http`: `hub.challenge` verification, `X-Hub-Signature-256`
  HMAC check over the raw body, body size limit, `leadgen` change parsing with
  batching and de-duplication, `immediate` and `after-processing` acknowledgement.
- Graph API client for `GET /{leadgen_id}` with bearer token, `appsecret_proof`,
  per-Page tokens, configurable version and fields, and retries on transient
  errors and rate limits.
- Idempotency stores: in-memory, JSON file (atomic writes) and SQLite through
  `node:sqlite`, with claims, partial-delivery tracking, a retry sweep and
  retention pruning.
- Sinks: Google Sheets (service account JWT, token cache, `values.append`, header
  row, formula escaping), generic webhook / n8n (HMAC signature, idempotency key)
  and Telegram (`sendMessage`, HTML templates, `retry_after`).
- Field mapping from the config file with sources, fallbacks, defaults, per-form
  mappings and transforms, including Bangladeshi phone normalisation and time
  zone formatting.
- JSON config with `${ENV}` substitution and validation.
- CLI: `serve`, `check-config`, `replay`, `retry`, `sign` and `phone`.
- Admin endpoints (stats, lead lookup, replay) behind a bearer token, and
  `/healthz`.
- Dockerfile, Docker Compose example with Caddy for HTTPS, and a GitHub Packages
  publishing workflow.

[Unreleased]: https://github.com/saizul/meta-lead-ads-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/meta-lead-ads-sync/releases/tag/v0.1.0
