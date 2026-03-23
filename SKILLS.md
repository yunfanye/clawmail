# Clawmail Agent Skills

Agent operations guides for the Clawmail email system. For full request/response schemas, see `API.md`.

| Skill | Auth | Description |
|---|---|---|
| [Domain Operations](skills/domain-operations.md) | `Bearer <verification_token>` | Domain registration, DNS verification, inbox provisioning, inbox listing, forwarding rules |
| [Inbox Operations](skills/inbox-operations.md) | `Bearer <email>:<api_key>` | List, read, send, reply, archive emails, download attachments |

## Workflow

1. **Domain setup** → Follow [Domain Operations](skills/domain-operations.md) to register, verify, configure DNS, and create inboxes
2. **Email operations** → Follow [Inbox Operations](skills/inbox-operations.md) to read, send, reply, and archive email
