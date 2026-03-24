# Clawmail API Reference

Agent-oriented email system for domain registration, inbox API keys, inbound SMTP, and read/send/reply/archive email APIs.

For agent operating guidance, see `SKILLS.md`.

**Base URL**: `https://clawmail.org` when deployed behind a reverse proxy, or `http://localhost:3000` for direct local access

---

## Authentication

### Domain-level auth
Used for domain operations, inbox provisioning, and forwarding rules.

```http
Authorization: Bearer <verification_token>
```

### Inbox creation auth
Used only for `POST /api/v1/api-keys`.

This route accepts either:

- `Authorization: Bearer <verification_token>`
- `Authorization: Bearer <inbox_creation_key>`

### Inbox-level auth
Used for inbox email operations.

```http
Authorization: Bearer <email>:<inbox_api_key>
```

---

## Endpoints

### Health Check

```bash
curl http://localhost:3000/health
```

**Response** (200):
```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

---

## Domain Operations

### 1. Register a Domain

Submit a domain to get DNS verification instructions.
Calling this endpoint again for the same unverified domain rotates the pending
`verification_token` and `dns_txt_value`, invalidating the previous pair.
If `DOMAIN_REGISTER_TOKEN` is configured on the server, this endpoint also
requires `Authorization: Bearer <DOMAIN_REGISTER_TOKEN>`.

```bash
curl -X POST http://localhost:3000/api/v1/domains/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DOMAIN_REGISTER_TOKEN>" \
  -d '{"domain": "clawmail.org"}'
```

**Response** (201):
```json
{
  "verification_token": "abc123...",
  "dns_txt_record": "_clawmail.clawmail.org",
  "dns_txt_value": "clawmail-verify=xyz789...",
  "mx_record": "mx.clawmail.org",
  "a_record": { "name": "mx.clawmail.org", "value": "203.0.113.10" }
}
```

Set these DNS records at your domain registrar:

- **TXT**: `_clawmail.clawmail.org` -> `clawmail-verify=xyz789...`
- **MX**: `clawmail.org` -> `mx.clawmail.org` (priority 10)
- **A**: `mx.clawmail.org` -> `203.0.113.10` (your server IP)

---

### 2. Verify a Domain

After DNS records are set, verify the domain.

```bash
curl -X POST http://localhost:3000/api/v1/domains/verify \
  -H "Content-Type: application/json" \
  -d '{"verification_token": "abc123..."}'
```

**Response** (200):
```json
{
  "domain": "clawmail.org",
  "verified": true,
  "dkim": {
    "selector": "clawmail2026",
    "dns_record_name": "clawmail2026._domainkey.clawmail.org",
    "dns_record_value": "v=DKIM1; k=rsa; p=MIIBIjAN..."
  }
}
```

Add the DKIM TXT record to DNS for email signing.

---

### 3. Create an Inbox Creation Key

Create a one-time token for delegated inbox API key creation.

```bash
curl -X POST http://localhost:3000/api/v1/inbox-creation-keys \
  -H "Authorization: Bearer <verification_token>"
```

**Response** (201):
```json
{
  "inbox_creation_key": "cmic_a1b2c3d4...",
  "key_prefix": "cmic_a1b2c3",
  "expires_at": "2026-01-01T01:00:00Z"
}
```

`inbox_creation_key` can be used once, must not be expired, and can be revoked server-side.

---

### 4. Create an Inbox API Key

Create an inbox API key for an inbox. If the inbox does not yet exist, it is created as part of this call.

```bash
curl -X POST http://localhost:3000/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <inbox_creation_key>" \
  -d '{"email": "agent@clawmail.org", "label": "my-agent"}'
```

**Response** (201):
```json
{
  "api_key": "cm_a1b2c3d4...",
  "key_prefix": "cm_a1b2c3d4",
  "email": "agent@clawmail.org",
  "label": "my-agent"
}
```

This route also accepts `Authorization: Bearer <verification_token>`.

`api_key` is shown only once. Store it securely.

---

### 5. List Inboxes

List all inboxes for a verified domain with unread counts and quota usage.

```bash
curl http://localhost:3000/api/v1/inboxes \
  -H "Authorization: Bearer <verification_token>"
```

**Response** (200):
```json
{
  "inboxes": [
    {
      "id": "uuid",
      "address": "agent@clawmail.org",
      "local_part": "agent",
      "created_at": "2026-01-01T00:00:00Z",
      "storage_used_bytes": "1048576",
      "storage_quota_bytes": "524288000",
      "is_catch_all": false,
      "unread_count": "3"
    }
  ]
}
```

---

### 6. Create a Forwarding Rule

Create a regex-based forwarding rule for a domain. Each rule applies `regex_pattern`
to one selected inbound email field, and matching emails are forwarded to the destination.

Forwarding rules use the RE2 regex engine, not JavaScript `RegExp`.

- Maximum `regex_pattern` length: `1024` characters
- Supported: plain text matches, anchors like `^` and `$`, alternation like `foo|bar`, groups, character classes, and inline RE2 flags such as `(?i)`
- Not supported: lookahead, negative lookahead, lookbehind, or backreferences
- Matching is applied to exactly one field: `from`, `to`, or `subject`

Examples:

- Supported: `urgent|critical`
- Supported: `^(?i:invoice|receipt)`
- Unsupported: `^(?=.*invoice).*$`
- Unsupported: `(foo)\1`

```bash
curl -X POST http://localhost:3000/api/v1/forwarding-rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <verification_token>" \
  -d '{
    "match_field": "subject",
    "regex_pattern": "urgent|critical",
    "destination_email": "alerts@other.com"
  }'
```

**Response** (201):
```json
{
  "id": "uuid",
  "match_field": "subject",
  "regex_pattern": "urgent|critical",
  "destination_email": "alerts@other.com",
  "is_active": true,
  "created_at": "2026-01-01T00:00:00Z"
}
```

`match_field` options: `from`, `to`, `subject`.

---

### 7. List Forwarding Rules

```bash
curl http://localhost:3000/api/v1/forwarding-rules \
  -H "Authorization: Bearer <verification_token>"
```

**Response** (200):
```json
{
  "rules": [
    {
      "id": "uuid",
      "match_field": "subject",
      "regex_pattern": "urgent|critical",
      "destination_email": "alerts@other.com",
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

---

### 8. Delete a Forwarding Rule

```bash
curl -X DELETE http://localhost:3000/api/v1/forwarding-rules/<rule-id> \
  -H "Authorization: Bearer <verification_token>"
```

**Response**: `204 No Content`

---

## Email Operations

### 9. List Emails

Read emails from an inbox with pagination and filtering.

- `page` must be a positive integer
- `limit` must be a positive integer no greater than `100`
- `is_archived` and `is_read` accept `true` or `false`
- Default `page=1`
- Default `limit=20`
- Default email list view is non-archived mail because `is_archived` defaults to `false`

```bash
# Non-archived emails only (default)
curl "http://localhost:3000/api/v1/emails?page=1&limit=20" \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>"

# Unread emails only
curl "http://localhost:3000/api/v1/emails?is_read=false" \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>"

# Archived emails only
curl "http://localhost:3000/api/v1/emails?is_archived=true" \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>"
```

**Response** (200):
```json
{
  "emails": [
    {
      "id": "uuid",
      "message_id": "<msg@clawmail.org>",
      "thread_id": "uuid",
      "direction": "inbound",
      "from_address": "sender@other.com",
      "envelope_from_address": "bounce@mailer.other.com",
      "sender_warning": "Header From (sender@other.com) does not match SMTP envelope sender (bounce@mailer.other.com).",
      "authentication_results": {
        "spf": {
          "result": "pass",
          "domain": "mailer.other.com",
          "comment": "mx.clawmail.org: domain of bounce@mailer.other.com designates 198.51.100.7 as permitted sender"
        },
        "dkim": {
          "result": "pass",
          "signatures": [
            {
              "result": "pass",
              "signing_domain": "other.com",
              "selector": "default",
              "algorithm": "rsa-sha256",
              "aligned": true
            }
          ]
        },
        "dmarc": {
          "result": "pass",
          "domain": "other.com",
          "policy": "reject",
          "comment": "p=REJECT",
          "header_from": "other.com",
          "alignment": {
            "spf": { "result": "other.com", "strict": false },
            "dkim": { "result": "other.com", "strict": false, "underSized": false }
          }
        }
      },
      "to_addresses": ["agent@clawmail.org"],
      "cc_addresses": [],
      "subject": "Hello",
      "body_text": "Hi there",
      "body_html": "<p>Hi there</p>",
      "has_attachments": false,
      "attachments": ["invoice.pdf"],
      "is_read": false,
      "is_archived": false,
      "received_at": "2026-01-01T00:00:00Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

---

### 10. Download Attachments

Download attachments for a specific email.

- Default behavior is `format=auto`
- `format=auto` returns the raw file if the email has exactly one attachment
- `format=auto` returns a zip archive if the email has more than one attachment
- `format=zip` always returns a zip archive, even when there is only one attachment
- Attachments expire automatically only when `ATTACHMENT_TTL_HOURS` is set
- Expired attachments return `410 Gone`

```bash
# Auto mode: single attachment streams directly, multiple attachments stream as zip
curl -L "http://localhost:3000/api/v1/emails/<email-id>/attachments/download" \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>" \
  -o attachments.bin

# Force zip output
curl -L "http://localhost:3000/api/v1/emails/<email-id>/attachments/download?format=zip" \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>" \
  -o attachments.zip
```

**Response**:

- `200 OK` with the attachment file body when exactly one attachment is available in `auto` mode
- `200 OK` with a zip archive body when multiple attachments exist or when `format=zip`
- `410 Gone` when attachment expiration is enabled and the email's attachments are older than the configured attachment TTL

---

### 11. Send an Email

Send a new email from an inbox with DKIM signing.

```bash
curl -X POST http://localhost:3000/api/v1/emails/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>" \
  -d '{
    "to": ["recipient@other.com"],
    "subject": "Hello from Clawmail",
    "text": "This is a test email.",
    "html": "<p>This is a test email.</p>"
  }'
```

**Response** (201):
```json
{
  "id": "uuid",
  "message_id": "<uuid@clawmail.org>",
  "thread_id": "uuid",
  "created_at": "2026-01-01T00:00:00Z"
}
```

Optional fields: `cc`, `bcc` (arrays or strings of email addresses).

---

### 12. Reply to an Email

Reply to an existing email, preserving threading headers.

```bash
curl -X POST http://localhost:3000/api/v1/emails/<email-id>/reply \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>" \
  -d '{
    "text": "Thanks for your message!"
  }'
```

**Response** (201):
```json
{
  "id": "uuid",
  "message_id": "<uuid@clawmail.org>",
  "thread_id": "uuid",
  "created_at": "2026-01-01T00:00:00Z"
}
```

Optional fields: `html`, `cc`, `bcc`.

---

### 13. Archive an Email

```bash
curl -X POST http://localhost:3000/api/v1/emails/<email-id>/archive \
  -H "Authorization: Bearer agent@clawmail.org:<inbox_api_key>"
```

**Response** (200):
```json
{
  "id": "uuid",
  "is_archived": true
}
```

---

## Rate Limits

| Endpoint Category | Limit |
|---|---|
| Domain registration | 5 requests / hour |
| Domain-auth routes mounted with `readLimiter` | 60 requests / minute |
| Inbox email send & reply | 10 requests / hour |
| Inbox email reads, downloads, archive | 100 requests / hour |

Inbox email routes are rate-limited by client IP by default. Set `INBOX_RATE_LIMIT_SCOPE=email` to bucket authenticated inbox email routes by inbox address instead.

---

## SMTP Inbound

The server listens on `SMTP_PORT` for inbound SMTP.

- Default `SMTP_PORT` is `25`
- Maximum inbound message size is `25 MiB`
- Only verified domains are accepted at RCPT time
- Inbound mail for an explicitly provisioned inbox is stored in that inbox
- Inbound mail for an unknown local part is routed to `catchall@<domain>` by default instead of auto-creating a new inbox
- Each inbox has a storage quota of `500 MiB` by default
- Once a mailbox reaches its quota, new inbound deliveries and stored outbound copies for that mailbox are rejected

---

## Outbound DKIM

All outbound emails are signed with DKIM using per-domain RSA-2048 keys. After domain verification, add the returned DKIM TXT record to DNS.

---

## DNS & Deliverability Setup

For each domain you register, set the following DNS records:

| Record | Name | Value |
|---|---|---|
| **TXT** | `_clawmail.<domain>` | Value from `/register` response |
| **MX** | `<domain>` | `mx.<domain>` (priority 10) |
| **A** | `mx.<domain>` | Your server IP |
| **TXT** | `<selector>._domainkey.<domain>` | DKIM value from `/verify` response |
| **TXT** | `<domain>` | `v=spf1 a:mx.<domain> -all` |
| **TXT** | `_dmarc.<domain>` | `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` |

### SPF

SPF tells receiving mail servers which hosts are authorized to send email for your domain.

```dns
clawmail.org  TXT  "v=spf1 a:mx.clawmail.org -all"
```

### DMARC

DMARC builds on SPF and DKIM to tell receivers what to do with emails that fail authentication. Start with `p=none`, then move to `p=quarantine` or `p=reject` once deliverability is confirmed.

```dns
_dmarc.clawmail.org  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@clawmail.org"
```

### Reverse DNS (rDNS / PTR)

To ensure outbound emails pass spam filters, set up Forward-Confirmed reverse DNS (FCrDNS). You can only have one PTR record per IP, so pick a primary mail hostname such as `mx.clawmail.org`.

1. Ensure `mx.clawmail.org` has an A record pointing to your server IP.
2. Set reverse DNS for your server IP to `mx.clawmail.org` through your hosting provider.
3. Leave `SMTP_BANNER_HOSTNAME` blank to derive `mx.<APP_DOMAIN>`, or set it explicitly so the EHLO greeting matches the PTR.

The A record, PTR record, and SMTP banner hostname must resolve to the same hostname for FCrDNS to pass.
