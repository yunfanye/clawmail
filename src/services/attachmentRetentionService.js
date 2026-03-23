const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');

const attachmentRoot = path.resolve(config.attachmentsDir);
const CLEANUP_BATCH_SIZE = 100;

function toTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getAttachmentExpiresAt(createdAt) {
  if (!config.attachmentTtlMs) return null;

  const createdAtMs = toTimestamp(createdAt);
  if (createdAtMs === null) return null;
  return new Date(createdAtMs + config.attachmentTtlMs);
}

function isAttachmentExpired(createdAt, now = new Date()) {
  const expiresAt = getAttachmentExpiresAt(createdAt);
  if (!expiresAt) return false;
  return expiresAt.getTime() <= toTimestamp(now);
}

function isWithinAttachmentRoot(filePath) {
  const relative = path.relative(attachmentRoot, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function removeStoredAttachmentFile(storagePath) {
  const resolvedPath = path.resolve(storagePath);
  if (!isWithinAttachmentRoot(resolvedPath)) {
    logger.warn({ storagePath }, 'Skipping expired attachment file outside configured attachment directory');
    return;
  }

  try {
    await fs.promises.rm(resolvedPath, { force: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
}

async function cleanupEmailAttachmentDirectory(emailId) {
  const dirPath = path.resolve(config.attachmentsDir, emailId);

  try {
    await fs.promises.rmdir(dirPath);
  } catch (err) {
    if (['ENOENT', 'ENOTEMPTY'].includes(err.code)) return;
    logger.warn({ err, dirPath }, 'Failed to remove expired attachment directory');
  }
}

function sumAttachmentBytesByInbox(rows) {
  const totals = new Map();

  for (const row of rows) {
    const bytes = Math.max(0, Number(row.size_bytes) || 0);
    totals.set(row.inbox_id, (totals.get(row.inbox_id) || 0) + bytes);
  }

  return totals;
}

async function cleanupExpiredAttachments({ batchSize = CLEANUP_BATCH_SIZE } = {}) {
  if (!config.attachmentTtlMs) {
    return 0;
  }

  let deletedCount = 0;

  while (true) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT a.id, a.email_id, a.storage_path, a.size_bytes, e.inbox_id
         FROM email_attachments a
         JOIN emails e ON e.id = a.email_id
         WHERE a.created_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')
         ORDER BY a.created_at ASC
         LIMIT $2
         FOR UPDATE OF a SKIP LOCKED`,
        [config.attachmentTtlMs, batchSize]
      );

      if (rows.length === 0) {
        await client.query('COMMIT');
        return deletedCount;
      }

      for (const row of rows) {
        await removeStoredAttachmentFile(row.storage_path);
      }

      const attachmentIds = rows.map((row) => row.id);
      const emailIds = [...new Set(rows.map((row) => row.email_id))];

      await client.query(
        'DELETE FROM email_attachments WHERE id = ANY($1::uuid[])',
        [attachmentIds]
      );

      for (const [inboxId, bytes] of sumAttachmentBytesByInbox(rows)) {
        await client.query(
          `UPDATE inboxes
           SET storage_used_bytes = GREATEST(storage_used_bytes - $2, 0)
           WHERE id = $1`,
          [inboxId, bytes]
        );
      }

      await client.query(
        `UPDATE emails e
         SET has_attachments = EXISTS (
           SELECT 1
           FROM email_attachments a
           WHERE a.email_id = e.id
         )
         WHERE e.id = ANY($1::uuid[])`,
        [emailIds]
      );

      await client.query('COMMIT');
      deletedCount += rows.length;

      await Promise.all(emailIds.map((emailId) => cleanupEmailAttachmentDirectory(emailId)));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr }, 'Failed to roll back expired attachment cleanup');
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

async function runCleanupCycle(trigger) {
  try {
    const deletedCount = await cleanupExpiredAttachments();
    if (deletedCount > 0) {
      logger.info({ deletedCount, trigger }, 'Expired attachments cleaned up');
    }
  } catch (err) {
    logger.error({ err, trigger }, 'Expired attachment cleanup failed');
  }
}

function startAttachmentExpirationJob() {
  if (!config.attachmentTtlMs) {
    return null;
  }

  logger.info(
    {
      attachmentTtlMs: config.attachmentTtlMs,
      cleanupIntervalMs: config.attachmentCleanupIntervalMs,
    },
    'Attachment expiration enabled'
  );

  void runCleanupCycle('startup');

  const timer = setInterval(() => {
    void runCleanupCycle('interval');
  }, config.attachmentCleanupIntervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

module.exports = {
  getAttachmentExpiresAt,
  isAttachmentExpired,
  cleanupExpiredAttachments,
  startAttachmentExpirationJob,
};
