ALTER TABLE inboxes
ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0;

UPDATE inboxes i
SET storage_used_bytes = (
  COALESCE((
    SELECT SUM(
      octet_length(COALESCE(e.message_id, ''))
      + octet_length(COALESCE(e.in_reply_to, ''))
      + octet_length(COALESCE(e.references_header, ''))
      + octet_length(COALESCE(e.from_address, ''))
      + octet_length(COALESCE(e.to_addresses::text, ''))
      + octet_length(COALESCE(e.cc_addresses::text, ''))
      + octet_length(COALESCE(e.bcc_addresses::text, ''))
      + octet_length(COALESCE(e.subject, ''))
      + octet_length(COALESCE(e.body_text, ''))
      + octet_length(COALESCE(e.body_html, ''))
      + octet_length(COALESCE(e.headers::text, ''))
    )
    FROM emails e
    WHERE e.inbox_id = i.id
  ), 0)
  + COALESCE((
    SELECT SUM(COALESCE(a.size_bytes, 0))
    FROM emails e
    JOIN email_attachments a ON a.email_id = e.id
    WHERE e.inbox_id = i.id
  ), 0)
);
