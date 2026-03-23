---
name: Domain Operations
description: Domain-level operations for Clawmail — domain registration, DNS verification, inbox provisioning, inbox listing, and forwarding rule management. Use when setting up a new domain, creating inboxes, or managing email forwarding rules. Requires domain-level auth (verification_token).
---

# Domain Operations

Domain-level operations for registering domains, provisioning inboxes, and managing forwarding rules. All endpoints (except register and verify) require domain auth.

**Auth**: `Authorization: Bearer <verification_token>`

**Base URL**: `https://clawmail.org`

---

## Setup Flow

Complete steps 1–4 in order before any email operations.

### 1. Register a domain

```
POST /api/v1/domains/register
Authorization: Bearer <DOMAIN_REGISTER_TOKEN>   # only if server requires it
{"domain": "example.com"}
```

Save the `verification_token` — it is the domain-level credential for all subsequent operations.

Re-registering an unverified domain rotates the token, invalidating the previous one.

### 2. Configure DNS

Set these records at the domain registrar before verifying:

| Record | Name | Value |
|---|---|---|
| TXT | `_clawmail.<domain>` | `dns_txt_value` from register response |
| MX | `<domain>` | `mx.<domain>` (priority 10) |
| A | `mx.<domain>` | Server IP from `a_record.value` |

### 3. Verify the domain

```
POST /api/v1/domains/verify
{"verification_token": "<verification_token>"}
```

After verification, add these DNS records for outbound deliverability:

| Record | Name | Value |
|---|---|---|
| TXT | `<selector>._domainkey.<domain>` | DKIM value from verify response |
| TXT | `<domain>` | `v=spf1 a:mx.<domain> -all` |
| TXT | `_dmarc.<domain>` | `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` |

### 4. Create an inbox

**Option A — Direct (domain auth):**
```
POST /api/v1/api-keys
Authorization: Bearer <verification_token>
{"email": "agent@example.com", "label": "my-agent"}
```

**Option B — Delegated (one-time inbox creation key):**
```
# Generate a one-time key
POST /api/v1/inbox-creation-keys
Authorization: Bearer <verification_token>

# Use it to create the inbox API key
POST /api/v1/api-keys
Authorization: Bearer <inbox_creation_key>
{"email": "agent@example.com", "label": "my-agent"}
```

Save the returned `api_key` immediately — it is shown only once. Inbox creation keys are single-use, expire, and can be revoked.

---

## Inbox Management

### List inboxes

```
GET /api/v1/inboxes
Authorization: Bearer <verification_token>
```

Returns all inboxes with `unread_count`, `storage_used_bytes`, and `storage_quota_bytes`.

- Each inbox has a 500 MiB storage quota. Monitor usage and alert before it fills.
- Mail to unknown local parts goes to `catchall@<domain>`. Create an API key for that address to read catch-all deliveries.

---

## Forwarding Rules

Regex-based rules that forward matching inbound emails to another address.

### Create a rule

```
POST /api/v1/forwarding-rules
Authorization: Bearer <verification_token>
{
  "match_field": "subject",
  "regex_pattern": "urgent|critical",
  "destination_email": "alerts@other.com"
}
```

- `match_field`: `from`, `to`, or `subject`
- Uses RE2 regex — no lookahead, lookbehind, or backreferences
- Max pattern length: 1024 characters

### List rules

```
GET /api/v1/forwarding-rules
Authorization: Bearer <verification_token>
```

### Delete a rule

```
DELETE /api/v1/forwarding-rules/<rule-id>
Authorization: Bearer <verification_token>
```

---

## Rate Limits

| Operation | Limit |
|---|---|
| Domain registration | 5 / hour |
| All other domain-auth routes | 60 / minute |

Back off and retry after rate limit errors.

---

## Secret Storage

By default, save domain credentials to `~/.clawmail/domain_secrets.csv` (create the file and directory if they don't exist). Format: one line per domain, pipe-separated:

```
domain,token
```

Example:
```
example.com,cmvt_x9y8z7...
```

---

## Credential Handling

- `verification_token` is a secret. Never log or expose it.
- `inbox_creation_key` values are one-time use. Generate a new one for each inbox.

---

## See Also

For inbox-level operations (reading, sending, replying, archiving emails, and downloading attachments), see [`skills/inbox-operations.md`](https://github.com/yunfanye/clawmail/blob/main/skills/inbox-operations.md).
