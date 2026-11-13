# Security policy

## Supported versions

Security fixes are made for the latest released minor version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/saizul/meta-lead-ads-sync/security/advisories/new)
for this repository and include a description, the request or configuration
that triggers the problem and the version you used.

You can expect an acknowledgement within a few days. Once a fix is released
the advisory is published with credit to the reporter, unless you prefer to
stay anonymous.

## Scope

meta-lead-ads-sync is an internet-facing service that holds an App Secret, Page
access tokens, a Google service account key and bot tokens. Things that count
as vulnerabilities include:

- a webhook request processed without a valid `X-Hub-Signature-256`, or a way
  to make the signature check pass for a modified body
- reflecting attacker-controlled content from the verification endpoint
- reaching `/admin` endpoints without the admin token
- any secret (App Secret, access tokens, service account key, bot token,
  webhook secret) written to logs, error responses, the store or a sink
- lead data written to logs
- spreadsheet formula injection with `valueInputOption: USER_ENTERED`
- request handling that lets a client exhaust memory or keep connections open
  indefinitely
- the same lead delivered twice to a sink that already acknowledged it

Problems in Meta's, Google's or Telegram's APIs should be reported to them.

## Handling secrets

Never paste real tokens or keys into issues. If one was exposed, rotate it:
App Secret in the Meta App Dashboard, Page tokens by generating new ones, the
service account key in Google Cloud IAM, and the bot token with @BotFather.
