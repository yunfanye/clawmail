# Clawmail

Agent-oriented email system for domain registration, inbox API keys, inbound SMTP, and read/send/reply/archive email APIs.

## Get Started

For a deployed server:

```bash
cp .env.example .env
```

Set only:

- `APP_DOMAIN` to the email domain you want Clawmail to serve
- `DOMAIN_REGISTER_TOKEN` if you want `POST /api/v1/domains/register` to require a shared token

Then run:

```bash
./deploy.sh setup
```

`./deploy.sh setup` validates `.env`, fills in generated values, configures Caddy, sets up SMTP certificate paths, and deploys the app.

Later, after code or config changes, redeploy with:

```bash
./deploy.sh
```

## Local Development

Requires Node.js `20.18.1` or newer.

```bash
cp .env.example .env
pnpm install
pnpm run migrate
pnpm run dev
```

Local API: `http://localhost:3000`  
Example deployed URL: `https://clawmail.org`

## Limits

- Inbound SMTP message size: `25 MiB` total per message, including attachments and MIME encoding overhead. There is currently no separate per-attachment cap.
- HTTP JSON request body size: `25 MB` per request.
- Per-mailbox storage quota: `500 MiB` by default. Inbound deliveries and stored outbound copies are rejected once the mailbox reaches its quota.
- Domain registration rate limit: `5` requests per hour per client IP.
- Domain-auth read routes rate limit: `60` requests per minute per client IP for `GET /api/v1/inboxes`, `POST /api/v1/inbox-creation-keys`, `POST /api/v1/api-keys`, and forwarding-rule routes.
- Inbox send/reply rate limit: `10` requests per hour, scoped by client IP by default or by inbox address when `INBOX_RATE_LIMIT_SCOPE=email`.
- Inbox read/archive rate limit: `100` requests per hour, scoped by client IP by default or by inbox address when `INBOX_RATE_LIMIT_SCOPE=email`.
- Inbox email list page size: maximum `100` items per request.

## Inbox Delivery

- Inbound mail for an explicitly provisioned inbox is stored in that inbox.
- Inbound mail for an unknown local part is routed to `catchall@<domain>` by default instead of auto-creating a new inbox.
- Create an inbox API key for `catchall@<domain>` if you want to read catch-all deliveries via the inbox API.
- Forwarding rule regex patterns: maximum `1024` characters.

## Forwarding Regex Requirements

Forwarding rules use the RE2 regex engine, not JavaScript `RegExp`.

- Supported: plain text matches, anchors like `^` and `$`, alternation like `foo|bar`, groups, character classes, and inline RE2 flags such as `(?i)`.
- Not supported: lookahead, negative lookahead, lookbehind, and backreferences.
- Matching is evaluated against exactly one field per rule: `from`, `to`, or `subject`.

Examples:

- Supported: `urgent|critical`
- Supported: `^(?i:invoice|receipt)`
- Unsupported: `^(?=.*invoice).*$`
- Unsupported: `(foo)\1`

## DNS Setup

### Inbound mail

| Record | Name | Value | Why |
|---|---|---|---|
| TXT | `_clawmail.clawmail.org` | Value returned by `POST /api/v1/domains/register` | Proves you own the domain so Clawmail will accept mail for it |
| MX | `clawmail.org` | `mx.clawmail.org` (priority `10`) | Tells other mail servers where to deliver mail for your domain |
| A | `mx.clawmail.org` | Your server IP | Resolves the MX hostname to your server's IP address |

### Outbound mail

| Record | Name | Value | Why |
|---|---|---|---|
| TXT | `clawmail2026._domainkey.clawmail.org` | Value returned by `POST /api/v1/domains/verify` | DKIM public key — lets recipients verify emails were not tampered with |
| TXT | `clawmail.org` | `v=spf1 a:mx.clawmail.org -all` | SPF — authorizes your server as the only sender for this domain |
| TXT | `_dmarc.clawmail.org` | `v=DMARC1; p=none; rua=mailto:dmarc@clawmail.org` | DMARC — tells receivers how to handle mail that fails SPF/DKIM checks |
| PTR | `your server IP` | `mx.clawmail.org` | Reverse DNS — many receivers reject mail when the IP doesn't resolve back to the sending hostname |

Leave `SMTP_BANNER_HOSTNAME` blank to derive `mx.<APP_DOMAIN>`, or set it explicitly so the SMTP banner matches the A/PTR hostname.

## API Flow

1. `POST /api/v1/domains/register`
   If `DOMAIN_REGISTER_TOKEN` is set, send `Authorization: Bearer <DOMAIN_REGISTER_TOKEN>`.
2. Add the inbound DNS records
3. `POST /api/v1/domains/verify`
4. Add DKIM/SPF/DMARC, create an inbox key, then create inbox API keys

Full API examples: [API.md](./API.md)

Agent skills:
- [Domain Operations](./skills/domain-operations.md) — domain registration, DNS verification, inbox provisioning, forwarding rules
- [Inbox Operations](./skills/inbox-operations.md) — create inbox from a creation key, read, send, reply, archive emails
