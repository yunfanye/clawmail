const db = require('../db');
const config = require('../config');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');

function buildInboxAddress(domain, localPart) {
  return `${localPart}@${domain}`;
}

async function findInboxByAddress(address, queryable = db) {
  const { rows } = await queryable.query(
    'SELECT id, domain_id, address, local_part, storage_used_bytes FROM inboxes WHERE address = $1',
    [address]
  );
  return rows[0] || null;
}

async function findOrCreateInbox(domainId, domain, localPart, queryable = db) {
  const address = buildInboxAddress(domain, localPart);
  const existing = await findInboxByAddress(address, queryable);
  if (existing) return existing;

  const { rows } = await queryable.query(
    `INSERT INTO inboxes (domain_id, address, local_part)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address
     RETURNING id, domain_id, address, local_part, storage_used_bytes`,
    [domainId, address, localPart]
  );
  return rows[0];
}

async function createInbox(domainId, domain, localPart, queryable = db) {
  const address = buildInboxAddress(domain, localPart);
  const { rows } = await queryable.query(
    `INSERT INTO inboxes (domain_id, address, local_part)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) DO NOTHING
     RETURNING id, domain_id, address, local_part, storage_used_bytes`,
    [domainId, address, localPart]
  );

  if (rows.length === 0) {
    throw new ConflictError('Inbox already exists');
  }

  return rows[0];
}

async function resolveDeliveryInbox(domainId, domain, localPart, queryable = db) {
  const requestedAddress = buildInboxAddress(domain, localPart);
  const requestedInbox = await findInboxByAddress(requestedAddress, queryable);
  if (requestedInbox) {
    return { inbox: requestedInbox, requestedAddress, isCatchAll: false };
  }

  const catchAllInbox = await findOrCreateInbox(domainId, domain, config.catchAllLocalPart, queryable);
  return {
    inbox: catchAllInbox,
    requestedAddress,
    isCatchAll: catchAllInbox.address !== requestedAddress,
  };
}

async function reserveInboxStorage(inboxId, bytes, queryable = db) {
  const additionalBytes = Math.max(0, Number(bytes) || 0);
  if (additionalBytes === 0) return null;

  const { rows } = await queryable.query(
    `UPDATE inboxes
     SET storage_used_bytes = storage_used_bytes + $2
     WHERE id = $1
       AND storage_used_bytes + $2 <= $3
     RETURNING storage_used_bytes`,
    [inboxId, additionalBytes, config.inboxStorageQuotaBytes]
  );

  if (rows.length === 0) {
    throw new BadRequestError('Mailbox storage quota exceeded');
  }

  return rows[0];
}

async function releaseInboxStorage(inboxId, bytes, queryable = db) {
  const releasedBytes = Math.max(0, Number(bytes) || 0);
  if (releasedBytes === 0) return null;

  const { rows } = await queryable.query(
    `UPDATE inboxes
     SET storage_used_bytes = GREATEST(storage_used_bytes - $2, 0)
     WHERE id = $1
     RETURNING storage_used_bytes`,
    [inboxId, releasedBytes]
  );

  return rows[0] || null;
}

async function listInboxes(domainId) {
  const { rows } = await db.query(
    `SELECT i.id, i.address, i.local_part, i.created_at,
       i.storage_used_bytes,
       $2::bigint AS storage_quota_bytes,
       (i.local_part = $3) AS is_catch_all,
       COUNT(e.id) FILTER (WHERE e.is_read = false AND e.is_archived = false AND e.direction = 'inbound') AS unread_count
     FROM inboxes i
     LEFT JOIN emails e ON e.inbox_id = i.id
     WHERE i.domain_id = $1
     GROUP BY i.id
     ORDER BY i.created_at`,
    [domainId, config.inboxStorageQuotaBytes, config.catchAllLocalPart]
  );
  return rows;
}

async function getInboxByAddress(address) {
  const inbox = await findInboxByAddress(address);
  if (!inbox) throw new NotFoundError('Inbox not found');
  return inbox;
}

module.exports = {
  createInbox,
  findOrCreateInbox,
  findInboxByAddress,
  resolveDeliveryInbox,
  reserveInboxStorage,
  releaseInboxStorage,
  listInboxes,
  getInboxByAddress,
};
