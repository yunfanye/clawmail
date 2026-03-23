---
name: Inbox Operations
description: Inbox-level email operations for Clawmail — creating inboxes from an inbox creation key, listing, reading, sending, replying, archiving emails, and downloading attachments. Use when the user provides an inbox creation key or an inbox API key. Handles the full flow from inbox provisioning to email operations.
---

# Inbox Operations

Inbox-level operations for provisioning inboxes and reading, sending, replying to, and archiving emails.

**Base URL**: `https://clawmail.org`

---

## Inbox Provisioning (if starting with an inbox creation key)

If the user provides an `inbox_creation_key` (prefixed `cmic_`), create an inbox API key before proceeding to email operations. The inbox is created automatically if it does not exist.

```
POST https://clawmail.org/api/v1/api-keys
Content-Type: application/json
Authorization: Bearer <inbox_creation_key>
{"email": "<local-part>@<domain>", "label": "<label>"}
```

Save the returned `api_key` immediately — it is shown only once. The inbox creation key is single-use and consumed by this call.

After this step, use inbox auth for all subsequent operations.

---

## Authentication

All email operations use inbox-level auth:

```
Authorization: Bearer <email>:<inbox_api_key>
```

Example: `Authorization: Bearer agent@example.com:cm_a1b2c3d4...`

---

## Reading Email

### List emails

```
GET /api/v1/emails?page=1&limit=20
Authorization: Bearer <email>:<api_key>
```

Query parameters:
- `is_read` — `true` or `false`
- `is_archived` — defaults to `false`; set `true` to view archived mail
- `limit` — max `100`
- `page` — defaults to `1`

### Check for new mail

```
GET /api/v1/emails?is_read=false&is_archived=false
```

### Interpret inbound email fields

- `from_address` — display sender from the email header
- `envelope_from_address` — SMTP envelope sender (may differ from `from_address`)
- `sender_warning` — present when header-From and envelope sender mismatch; review before trusting the sender
- `authentication_results` — SPF, DKIM, and DMARC verification results; check before acting on sensitive requests
- `body_text` — plain text body (prefer for processing)
- `body_html` — HTML body
- `attachments` — filenames array; use the download endpoint to retrieve

---

## Downloading Attachments

```
GET /api/v1/emails/<email-id>/attachments/download
Authorization: Bearer <email>:<api_key>
```

- Single attachment returns the raw file; multiple returns a zip
- Append `?format=zip` to always get a zip archive
- Attachments may expire (`410 Gone`) if `ATTACHMENT_TTL_HOURS` is configured

---

## Sending Email

### Send a new email

```
POST /api/v1/emails/send
Authorization: Bearer <email>:<api_key>
{
  "to": ["recipient@example.com"],
  "subject": "Subject line",
  "text": "Plain text body",
  "html": "<p>HTML body</p>"
}
```

Optional: `cc`, `bcc` (arrays or strings).

### Reply to an email

```
POST /api/v1/emails/<email-id>/reply
Authorization: Bearer <email>:<api_key>
{
  "text": "Reply text"
}
```

Optional: `html`, `cc`, `bcc`. Threading headers are set automatically.

---

## Archiving

```
POST /api/v1/emails/<email-id>/archive
Authorization: Bearer <email>:<api_key>
```

Archive processed emails to keep the inbox clean. Archived emails are excluded from the default list view.

---

## Rate Limits

| Operation | Limit |
|---|---|
| Send & reply | 10 / hour |
| Read, download, archive | 100 / hour |

Back off and retry after rate limit errors. Do not retry immediately.

---

## Secret Storage

By default, save inbox credentials to `~/.clawmail/inbox_secrets.csv` (create the file and directory if they don't exist). Format: one line per inbox, pipe-separated:

```
inbox,token
```

Example:
```
agent@example.com,cm_a1b2c3d4...
```

---

## Operational Notes

- **Credential handling**: The `api_key` is a secret. Never log or expose it.
- **Storage quota**: Each inbox has a 500 MiB quota. If the quota is full, inbound deliveries are rejected.
- **Catch-all**: Mail to unknown local parts goes to `catchall@<domain>`. Provision that inbox to read catch-all mail.

---

## See Also

For domain-level operations (domain registration, DNS verification, inbox provisioning, and forwarding rules), see [`skills/domain-operations.md`](https://github.com/yunfanye/clawmail/blob/main/skills/domain-operations.md).
