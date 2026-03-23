ALTER TABLE emails
ADD COLUMN IF NOT EXISTS envelope_from_address VARCHAR(320);

ALTER TABLE emails
ADD COLUMN IF NOT EXISTS sender_warning TEXT;

ALTER TABLE emails
ADD COLUMN IF NOT EXISTS authentication_results JSONB;

UPDATE emails
SET envelope_from_address = from_address
WHERE direction = 'outbound'
  AND envelope_from_address IS NULL;
