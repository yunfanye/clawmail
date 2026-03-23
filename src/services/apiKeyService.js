const db = require('../db');
const { generateApiKey, hashApiKey, getKeyPrefix } = require('../utils/crypto');
const inboxService = require('./inboxService');
const { BadRequestError, UnauthorizedError } = require('../utils/errors');

async function createApiKey(domainId, domain, email, label, options = {}) {
  const parts = email.split('@');
  if (parts.length !== 2 || parts[1].toLowerCase() !== domain) {
    throw new BadRequestError(`Email must be on the domain ${domain}`);
  }

  const localPart = parts[0].toLowerCase();
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = getKeyPrefix(rawKey);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const inbox = options.inboxCreationKeyId
      ? await inboxService.createInbox(domainId, domain, localPart, client)
      : await inboxService.findOrCreateInbox(domainId, domain, localPart, client);

    await client.query(
      'INSERT INTO api_keys (inbox_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4)',
      [inbox.id, keyHash, keyPrefix, label || null]
    );

    if (options.inboxCreationKeyId) {
      const { rowCount } = await client.query(
        `UPDATE inbox_creation_keys
         SET used_at = NOW()
         WHERE id = $1
           AND used_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > NOW()`,
        [options.inboxCreationKeyId]
      );

      if (rowCount === 0) {
        throw new UnauthorizedError('Inbox creation key is invalid or already used');
      }
    }

    await client.query('COMMIT');

    return {
      api_key: rawKey,
      key_prefix: keyPrefix,
      email: inbox.address,
      label: label || null,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function validateApiKey(email, rawKey) {
  const keyHash = hashApiKey(rawKey);
  const { rows } = await db.query(
    `SELECT ak.id AS key_id, ak.inbox_id, i.address, i.domain_id
     FROM api_keys ak
     JOIN inboxes i ON i.id = ak.inbox_id
     WHERE ak.key_hash = $1 AND i.address = $2 AND ak.revoked_at IS NULL`,
    [keyHash, email.toLowerCase()]
  );
  if (rows.length === 0) return null;

  await db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].key_id]);
  return rows[0];
}

module.exports = { createApiKey, validateApiKey };
