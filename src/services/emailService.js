const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const sender = require('../mail/sender');
const inboxService = require('./inboxService');
const { NotFoundError, BadRequestError } = require('../utils/errors');

const DEFAULT_EMAIL_LIST_LIMIT = 20;
const MAX_EMAIL_LIST_LIMIT = 100;

function getByteLength(value) {
  if (!value) return 0;
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
}

function calculateEmailStorageBytes({
  messageId,
  inReplyTo,
  referencesHeader,
  fromAddress,
  envelopeFromAddress,
  authenticationResults,
  toAddresses,
  ccAddresses,
  bccAddresses,
  subject,
  bodyText,
  bodyHtml,
  headers,
  attachmentBytes = 0,
  senderWarning,
}) {
  return [
    messageId,
    inReplyTo,
    referencesHeader,
    fromAddress,
    envelopeFromAddress,
    authenticationResults,
    toAddresses,
    ccAddresses,
    bccAddresses,
    subject,
    bodyText,
    bodyHtml,
    headers,
    senderWarning,
  ].reduce((total, value) => total + getByteLength(value), attachmentBytes);
}

function parsePositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestError(`${fieldName} must be a positive integer`);
  }
  return value;
}

async function listEmails(inboxId, { page = 1, limit = DEFAULT_EMAIL_LIST_LIMIT, is_archived = false, is_read } = {}) {
  const pageNumber = parsePositiveInteger(page, 'page');
  const pageLimit = parsePositiveInteger(limit, 'limit');
  if (pageLimit > MAX_EMAIL_LIST_LIMIT) {
    throw new BadRequestError(`limit must be less than or equal to ${MAX_EMAIL_LIST_LIMIT}`);
  }

  const offset = (pageNumber - 1) * pageLimit;
  const conditions = ['inbox_id = $1'];
  const params = [inboxId];
  let paramIndex = 2;

  if (is_archived !== undefined) {
    conditions.push(`is_archived = $${paramIndex++}`);
    params.push(is_archived === 'true' || is_archived === true);
  }
  if (is_read !== undefined) {
    conditions.push(`is_read = $${paramIndex++}`);
    params.push(is_read === 'true' || is_read === true);
  }

  const where = conditions.join(' AND ');

  const countResult = await db.query(
    `SELECT COUNT(*) FROM emails WHERE ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const { rows } = await db.query(
    `SELECT e.id, e.message_id, e.in_reply_to, e.thread_id, e.direction, e.from_address,
       e.envelope_from_address, e.sender_warning, e.authentication_results,
       e.to_addresses, e.cc_addresses, e.subject, e.body_text, e.body_html,
       e.has_attachments, e.is_read, e.is_archived, e.received_at, e.created_at,
       COALESCE(
         (
           SELECT json_agg(
             a.filename
             ORDER BY a.created_at ASC
           )
           FROM email_attachments a
           WHERE a.email_id = e.id
         ),
         '[]'::json
       ) AS attachments
     FROM emails e
     WHERE ${where}
     ORDER BY e.received_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, pageLimit, offset]
  );

  return { emails: rows, total, page: pageNumber, limit: pageLimit };
}

async function getEmail(inboxId, emailId) {
  const { rows } = await db.query(
    `SELECT e.*, json_agg(
       json_build_object('id', a.id, 'filename', a.filename, 'content_type', a.content_type, 'size_bytes', a.size_bytes)
     ) FILTER (WHERE a.id IS NOT NULL) AS attachments
     FROM emails e
     LEFT JOIN email_attachments a ON a.email_id = e.id
     WHERE e.id = $1 AND e.inbox_id = $2
     GROUP BY e.id`,
    [emailId, inboxId]
  );
  if (rows.length === 0) throw new NotFoundError('Email not found');

  // Mark as read
  await db.query('UPDATE emails SET is_read = true WHERE id = $1', [emailId]);

  return rows[0];
}

async function listEmailAttachments(inboxId, emailId) {
  const { rows } = await db.query(
    `SELECT e.id AS email_id,
       a.id AS attachment_id,
       a.filename,
       a.content_type,
       a.size_bytes,
       a.storage_path,
       a.created_at
     FROM emails e
     LEFT JOIN email_attachments a ON a.email_id = e.id
     WHERE e.id = $1 AND e.inbox_id = $2
     ORDER BY a.created_at ASC NULLS LAST`,
    [emailId, inboxId]
  );

  if (rows.length === 0) {
    throw new NotFoundError('Email not found');
  }

  const attachments = rows
    .filter((row) => row.attachment_id)
    .map((row) => ({
      id: row.attachment_id,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      storage_path: row.storage_path,
      created_at: row.created_at,
    }));

  if (attachments.length === 0) {
    throw new NotFoundError('Email has no attachments');
  }

  return attachments;
}

async function sendNewEmail(inboxId, domainId, fromAddress, { to, cc, bcc, subject, text, html }) {
  if (!to || (Array.isArray(to) && to.length === 0)) {
    throw new BadRequestError('to is required');
  }

  const toArray = Array.isArray(to) ? to : [to];
  const ccArray = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const bccArray = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];
  const domain = fromAddress.split('@')[1];
  const messageId = `<${uuidv4()}@${domain}>`;

  const threadId = uuidv4();
  const storageBytes = calculateEmailStorageBytes({
    messageId,
    fromAddress,
    envelopeFromAddress: fromAddress,
    toAddresses: toArray,
    ccAddresses: ccArray,
    bccAddresses: bccArray,
    subject,
    bodyText: text || null,
    bodyHtml: html || null,
  });

  await inboxService.reserveInboxStorage(inboxId, storageBytes);

  try {
    await sender.sendEmail(domainId, domain, {
      from: fromAddress,
      to: toArray,
      cc: ccArray.length > 0 ? ccArray : undefined,
      bcc: bccArray.length > 0 ? bccArray : undefined,
      subject,
      text,
      html,
      messageId,
    });

    const { rows } = await db.query(
      `INSERT INTO emails (inbox_id, message_id, thread_id, direction, from_address, envelope_from_address,
         to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html, is_read)
       VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, $11, true)
       RETURNING id, message_id, thread_id, created_at`,
      [inboxId, messageId, threadId, fromAddress, fromAddress, JSON.stringify(toArray),
       JSON.stringify(ccArray), JSON.stringify(bccArray), subject, text || null, html || null]
    );

    return rows[0];
  } catch (err) {
    await inboxService.releaseInboxStorage(inboxId, storageBytes);
    throw err;
  }
}

async function replyToEmail(inboxId, domainId, fromAddress, emailId, { text, html, cc, bcc }) {
  const original = await getEmail(inboxId, emailId);

  const toAddress = original.direction === 'inbound' ? original.from_address : original.to_addresses[0];
  if (!toAddress) throw new BadRequestError('Cannot determine reply recipient');

  const domain = fromAddress.split('@')[1];
  const messageId = `<${uuidv4()}@${domain}>`;
  const inReplyTo = original.message_id;

  const existingRefs = original.references_header ? original.references_header.split(/\s+/) : [];
  if (original.message_id && !existingRefs.includes(original.message_id)) {
    existingRefs.push(original.message_id);
  }
  const references = existingRefs.length > 0 ? existingRefs : undefined;
  const referencesHeader = references ? references.join(' ') : null;
  const threadId = original.thread_id || uuidv4();
  const subject = original.subject?.startsWith('Re:') ? original.subject : `Re: ${original.subject || ''}`;

  const ccArray = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const bccArray = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];
  const storageBytes = calculateEmailStorageBytes({
    messageId,
    inReplyTo,
    referencesHeader,
    fromAddress,
    envelopeFromAddress: fromAddress,
    toAddresses: [toAddress],
    ccAddresses: ccArray,
    bccAddresses: bccArray,
    subject,
    bodyText: text || null,
    bodyHtml: html || null,
  });

  await inboxService.reserveInboxStorage(inboxId, storageBytes);

  try {
    await sender.sendEmail(domainId, domain, {
      from: fromAddress,
      to: [toAddress],
      cc: ccArray.length > 0 ? ccArray : undefined,
      bcc: bccArray.length > 0 ? bccArray : undefined,
      subject,
      text,
      html,
      inReplyTo,
      references,
      messageId,
    });

    const { rows } = await db.query(
      `INSERT INTO emails (inbox_id, message_id, in_reply_to, references_header, thread_id, direction,
         from_address, envelope_from_address, to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html, is_read)
       VALUES ($1, $2, $3, $4, $5, 'outbound', $6, $7, $8, $9, $10, $11, $12, $13, true)
       RETURNING id, message_id, thread_id, created_at`,
      [inboxId, messageId, inReplyTo, referencesHeader, threadId,
       fromAddress, fromAddress, JSON.stringify([toAddress]), JSON.stringify(ccArray), JSON.stringify(bccArray),
       subject, text || null, html || null]
    );

    return rows[0];
  } catch (err) {
    await inboxService.releaseInboxStorage(inboxId, storageBytes);
    throw err;
  }
}

async function archiveEmail(inboxId, emailId) {
  const { rowCount } = await db.query(
    'UPDATE emails SET is_archived = true WHERE id = $1 AND inbox_id = $2',
    [emailId, inboxId]
  );
  if (rowCount === 0) throw new NotFoundError('Email not found');
  return { id: emailId, is_archived: true };
}

module.exports = {
  listEmails,
  getEmail,
  listEmailAttachments,
  sendNewEmail,
  replyToEmail,
  archiveEmail,
};
