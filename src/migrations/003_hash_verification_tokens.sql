CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE pending_domains
SET verification_token = encode(digest(verification_token, 'sha256'), 'hex');

UPDATE verified_domains
SET verification_token = encode(digest(verification_token, 'sha256'), 'hex');
