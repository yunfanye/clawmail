const db = require('../db');
const { generateInboxCreationKey, hashApiKey, getKeyPrefix } = require('../utils/crypto');

async function createInboxCreationKey(domainId) {
  const rawKey = generateInboxCreationKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = getKeyPrefix(rawKey);

  const { rows } = await db.query(
    `INSERT INTO inbox_creation_keys (domain_id, key_hash, key_prefix)
     VALUES ($1, $2, $3)
     RETURNING expires_at`,
    [domainId, keyHash, keyPrefix]
  );

  return {
    inbox_creation_key: rawKey,
    key_prefix: keyPrefix,
    expires_at: rows[0].expires_at,
  };
}

async function getActiveInboxCreationKey(rawKey) {
  const keyHash = hashApiKey(rawKey);
  const { rows } = await db.query(
    `SELECT ick.id, ick.domain_id, vd.domain
     FROM inbox_creation_keys ick
     JOIN verified_domains vd ON vd.id = ick.domain_id
     WHERE ick.key_hash = $1
       AND ick.used_at IS NULL
       AND ick.revoked_at IS NULL
       AND ick.expires_at > NOW()
     LIMIT 1`,
    [keyHash]
  );

  return rows[0] || null;
}

module.exports = { createInboxCreationKey, getActiveInboxCreationKey };
