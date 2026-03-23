CREATE TABLE IF NOT EXISTS inbox_creation_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain_id UUID NOT NULL REFERENCES verified_domains(id) ON DELETE CASCADE,
  key_hash VARCHAR(128) NOT NULL UNIQUE,
  key_prefix VARCHAR(12) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_inbox_creation_keys_domain_id ON inbox_creation_keys(domain_id);
CREATE INDEX IF NOT EXISTS idx_inbox_creation_keys_key_hash ON inbox_creation_keys(key_hash);
