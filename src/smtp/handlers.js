const { MailParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { authenticate } = require('mailauth');
const db = require('../db');
const inboxService = require('../services/inboxService');
const forwardingService = require('../services/forwardingService');
const config = require('../config');
const logger = require('../utils/logger');

async function isVerifiedDomain(domain) {
  const { rows } = await db.query('SELECT id, domain FROM verified_domains WHERE domain = $1', [domain.toLowerCase()]);
  return rows.length > 0 ? rows[0] : null;
}

function getByteLength(value) {
  if (!value) return 0;
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
}

function calculateInboundStorageBytes({
  messageId,
  inReplyTo,
  referencesHeader,
  fromAddress,
  envelopeFromAddress,
  authenticationResults,
  toAddresses,
  ccAddresses,
  subject,
  bodyText,
  bodyHtml,
  headers,
  attachments,
  senderWarning,
}) {
  const attachmentBytes = (attachments || []).reduce(
    (total, attachment) => total + (attachment.size || 0),
    0
  );

  return [
    messageId,
    inReplyTo,
    referencesHeader,
    fromAddress,
    envelopeFromAddress,
    authenticationResults,
    toAddresses,
    ccAddresses,
    '[]',
    subject,
    bodyText,
    bodyHtml,
    headers,
    senderWarning,
  ].reduce((total, value) => total + getByteLength(value), attachmentBytes);
}

function normalizeAddressForComparison(value) {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function buildSenderWarning(fromAddress, envelopeFromAddress) {
  const normalizedHeaderFrom = normalizeAddressForComparison(fromAddress);
  const normalizedEnvelopeFrom = normalizeAddressForComparison(envelopeFromAddress);

  if (!normalizedHeaderFrom || !normalizedEnvelopeFrom) {
    return null;
  }

  if (normalizedHeaderFrom === normalizedEnvelopeFrom) {
    return null;
  }

  return `Header From (${fromAddress}) does not match SMTP envelope sender (${envelopeFromAddress}).`;
}

async function readMessageBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (stream.sizeExceeded) {
    const err = new Error('Message too large');
    err.responseCode = 552;
    throw err;
  }

  return Buffer.concat(chunks);
}

function getDkimResult(dkimResults) {
  if (!Array.isArray(dkimResults) || dkimResults.length === 0) {
    return 'none';
  }

  if (dkimResults.some((result) => result?.status?.result === 'pass')) {
    return 'pass';
  }

  return dkimResults[0]?.status?.result || 'none';
}

function formatAuthenticationResults(authenticationResult) {
  if (!authenticationResult) {
    return null;
  }

  const dkimResults = authenticationResult.dkim?.results || [];

  return {
    spf: {
      result: authenticationResult.spf?.status?.result || 'none',
      domain: authenticationResult.spf?.domain || null,
      comment: authenticationResult.spf?.status?.comment || null,
    },
    dkim: {
      result: getDkimResult(dkimResults),
      signatures: dkimResults.map((result) => ({
        result: result?.status?.result || 'none',
        signing_domain: result?.signingDomain || null,
        selector: result?.selector || null,
        algorithm: result?.algo || null,
        aligned: result?.status?.aligned || false,
      })),
    },
    dmarc: {
      result: authenticationResult.dmarc?.status?.result || 'none',
      domain: authenticationResult.dmarc?.domain || null,
      policy: authenticationResult.dmarc?.policy || null,
      comment: authenticationResult.dmarc?.status?.comment || null,
      header_from: authenticationResult.dmarc?.status?.header?.from || null,
      alignment: authenticationResult.dmarc?.alignment || null,
    },
  };
}

async function authenticateMessage(rawMessage, session, envelopeFromAddress) {
  try {
    const authenticationResult = await authenticate(rawMessage, {
      sender: envelopeFromAddress || undefined,
      ip: session.remoteAddress,
      helo: session.hostNameAppearsAs || session.clientHostname || undefined,
      mta: config.smtpBannerHostname || undefined,
      disableArc: true,
      disableBimi: true,
    });

    return formatAuthenticationResults(authenticationResult);
  } catch (err) {
    logger.warn({ err }, 'Inbound email authentication checks failed');
    return {
      spf: {
        result: 'temperror',
        domain: null,
        comment: err.message,
      },
      dkim: {
        result: 'temperror',
        signatures: [],
      },
      dmarc: {
        result: 'temperror',
        domain: null,
        policy: null,
        comment: err.message,
        header_from: null,
        alignment: null,
      },
    };
  }
}

async function onRcptTo(address, _session, callback) {
  const email = address.address;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return callback(new Error('Invalid recipient address'));

  const verified = await isVerifiedDomain(domain);
  if (!verified) {
    return callback(new Error(`Domain ${domain} is not registered`));
  }
  callback();
}

async function onData(stream, session, callback) {
  let parsed;
  try {
    const rawMessage = await readMessageBuffer(stream);
    const envelopeFromAddress = session.envelope?.mailFrom?.address || null;
    const authenticationResults = await authenticateMessage(rawMessage, session, envelopeFromAddress);
    parsed = await parseMessage(Readable.from([rawMessage]));
    const {
      fromAddress,
      toAddresses,
      ccAddresses,
      subject,
      messageId,
      inReplyTo,
      referencesHeader,
      text,
      html,
      headersObj,
      attachments,
      hasAttachments,
    } = parsed;
    const senderWarning = buildSenderWarning(fromAddress, envelopeFromAddress);
    const envelopeRecipients = [...new Set(
      (session.envelope?.rcptTo || [])
        .map(recipient => recipient.address?.toLowerCase())
        .filter(Boolean)
    )];

    const threadId = await computeThreadId(inReplyTo, referencesHeader);

    const headerRecipients = [...new Set(
      [...toAddresses, ...ccAddresses]
        .map(address => address?.toLowerCase())
        .filter(Boolean)
    )];

    const headerOnlyRecipients = headerRecipients.filter(
      recipient => !envelopeRecipients.includes(recipient)
    );

    if (headerOnlyRecipients.length > 0) {
      logger.warn(
        { envelopeRecipients, ignoredHeaderRecipients: headerOnlyRecipients },
        'Ignoring header recipients that were not accepted in the SMTP envelope'
      );
    }

    const deliveryTargets = [];
    const domainCache = new Map();

    for (const recipientEmail of envelopeRecipients) {
      const domain = recipientEmail.split('@')[1]?.toLowerCase();
      if (!domain) continue;

      if (!domainCache.has(domain)) {
        domainCache.set(domain, await isVerifiedDomain(domain));
      }

      const verifiedDomain = domainCache.get(domain);
      if (!verifiedDomain) continue;

      deliveryTargets.push({
        recipientEmail,
        domain,
        localPart: recipientEmail.split('@')[0].toLowerCase(),
        verifiedDomain,
      });
    }

    const client = await db.getClient();
    const emailIdsForCleanup = [];
    const forwardingJobs = [];

    try {
      await client.query('BEGIN');

      const deliveriesByInbox = new Map();

      for (const target of deliveryTargets) {
        const resolvedDelivery = await inboxService.resolveDeliveryInbox(
          target.verifiedDomain.id,
          target.domain,
          target.localPart,
          client
        );

        if (!deliveriesByInbox.has(resolvedDelivery.inbox.id)) {
          deliveriesByInbox.set(resolvedDelivery.inbox.id, {
            inbox: resolvedDelivery.inbox,
            verifiedDomain: target.verifiedDomain,
            envelopeRecipients: [],
          });
        }

        deliveriesByInbox.get(resolvedDelivery.inbox.id).envelopeRecipients.push(target.recipientEmail);
        forwardingJobs.push({ verifiedDomain: target.verifiedDomain, recipientEmail: target.recipientEmail, domain: target.domain });
      }

      for (const delivery of deliveriesByInbox.values()) {
        const storedToAddresses = toAddresses.length > 0 ? toAddresses : delivery.envelopeRecipients;
        const storedHeaders = {
          ...headersObj,
          ...(envelopeFromAddress ? { 'x-clawmail-envelope-from': envelopeFromAddress } : {}),
          'x-clawmail-envelope-to': delivery.envelopeRecipients,
        };
        const storageBytes = calculateInboundStorageBytes({
          messageId,
          inReplyTo,
          referencesHeader,
          fromAddress,
          envelopeFromAddress,
          authenticationResults,
          toAddresses: storedToAddresses,
          ccAddresses,
          subject,
          bodyText: text || null,
          bodyHtml: html || null,
          headers: storedHeaders,
          attachments,
          senderWarning,
        });

        await inboxService.reserveInboxStorage(delivery.inbox.id, storageBytes, client);

        const { rows } = await client.query(
          `INSERT INTO emails (inbox_id, message_id, in_reply_to, references_header, thread_id, direction,
            from_address, envelope_from_address, to_addresses, cc_addresses, bcc_addresses, subject,
            body_text, body_html, headers, has_attachments, is_read, is_archived, sender_warning,
            authentication_results)
           VALUES ($1, $2, $3, $4, $5, 'inbound', $6, $7, $8, $9, '[]', $10, $11, $12, $13, $14, false, false, $15, $16)
           RETURNING id`,
          [
            delivery.inbox.id, messageId, inReplyTo, referencesHeader, threadId,
            fromAddress, envelopeFromAddress, JSON.stringify(storedToAddresses), JSON.stringify(ccAddresses),
            subject, text || null, html || null,
            JSON.stringify(storedHeaders), hasAttachments, senderWarning, JSON.stringify(authenticationResults),
          ]
        );

        const emailId = rows[0].id;
        emailIdsForCleanup.push(emailId);

        if (hasAttachments) {
          await saveAttachments(client, emailId, attachments);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');

      for (const emailId of emailIdsForCleanup) {
        await cleanupDirectory(path.resolve(config.attachmentsDir, emailId));
      }

      if (err.message === 'Mailbox storage quota exceeded') {
        err.responseCode = 552;
      }

      throw err;
    } finally {
      client.release();
    }

    for (const job of forwardingJobs) {
      try {
        await forwardingService.processForwardingRules(job.verifiedDomain.id, {
          from: fromAddress,
          to: job.recipientEmail,
          subject,
          text: text || '',
          html: html || '',
          messageId,
        });
      } catch (err) {
        logger.error({ err, domain: job.domain }, 'Forwarding rules processing failed');
      }
    }

    logger.info({ from: fromAddress, to: toAddresses, subject }, 'Inbound email processed');
    callback();
  } catch (err) {
    logger.error({ err }, 'Error processing inbound email');
    callback(err);
  } finally {
    if (parsed?.attachmentTempDir) {
      await cleanupDirectory(parsed.attachmentTempDir);
    }
  }
}

function convertHeaderValue(value) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(convertHeaderValue);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    if ('value' in value) return value.value;
    if (typeof value.text === 'string') return value.text;
    return String(value);
  }

  return value;
}

async function parseMessage(stream) {
  const parser = new MailParser();
  const attachmentWrites = [];
  let text = '';
  let html = null;
  let headers = null;
  let attachmentTempDir = null;

  parser.on('headers', (parsedHeaders) => {
    headers = parsedHeaders;
  });

  parser.on('data', (part) => {
    if (part.type === 'text') {
      text = part.text || '';
      html = part.html || null;
      return;
    }

    if (part.type === 'attachment') {
      const attachmentWrite = spoolAttachmentToTemp(part, () => {
        if (!attachmentTempDir) {
          attachmentTempDir = path.resolve(config.attachmentsDir, '.incoming', uuidv4());
        }
        return attachmentTempDir;
      });
      attachmentWrites.push(attachmentWrite);
    }
  });

  const parsedPromise = new Promise((resolve, reject) => {
    parser.once('end', () => {
      if (stream.sizeExceeded) {
        const err = new Error('Message too large');
        err.responseCode = 552;
        return reject(err);
      }

      Promise.all(attachmentWrites)
        .then((attachments) => {
          const headersObj = {};
          if (headers) {
            for (const [key, value] of headers) {
              headersObj[key] = convertHeaderValue(value);
            }
          }

          const fromAddress = parser.from?.value?.[0]?.address || '';
          const toAddresses = (parser.to?.value || []).map((address) => address.address);
          const ccAddresses = (parser.cc?.value || []).map((address) => address.address);

          resolve({
            fromAddress,
            toAddresses,
            ccAddresses,
            subject: parser.subject || '',
            messageId: parser.messageId || null,
            inReplyTo: parser.inReplyTo || null,
            referencesHeader: parser.references
              ? (Array.isArray(parser.references) ? parser.references.join(' ') : parser.references)
              : null,
            text,
            html,
            headersObj,
            attachments,
            hasAttachments: attachments.length > 0,
            attachmentTempDir,
          });
        })
        .catch(reject);
    });
    parser.once('error', reject);
    stream.once('error', reject);
  });

  stream.pipe(parser);
  try {
    return await parsedPromise;
  } catch (err) {
    if (attachmentTempDir) {
      await cleanupDirectory(attachmentTempDir);
    }
    throw err;
  }
}

async function computeThreadId(inReplyTo, referencesHeader) {
  if (inReplyTo) {
    const { rows } = await db.query(
      'SELECT thread_id FROM emails WHERE message_id = $1 LIMIT 1',
      [inReplyTo]
    );
    if (rows.length > 0 && rows[0].thread_id) return rows[0].thread_id;
  }

  if (referencesHeader) {
    const refs = referencesHeader.split(/\s+/).filter(Boolean);
    for (const ref of refs) {
      const { rows } = await db.query(
        'SELECT thread_id FROM emails WHERE message_id = $1 LIMIT 1',
        [ref]
      );
      if (rows.length > 0 && rows[0].thread_id) return rows[0].thread_id;
    }
  }

  return uuidv4();
}

function sanitizeAttachmentFilename(filename) {
  if (typeof filename !== 'string') return null;

  const basename = path.posix.basename(filename.replace(/\\/g, '/'));
  const sanitized = basename.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return null;
  }

  return sanitized.slice(0, 255);
}

function buildAttachmentStorageName(filename) {
  const ext = filename ? path.extname(filename).slice(0, 32) : '';
  return ext ? `${uuidv4()}${ext}` : uuidv4();
}

async function saveAttachments(queryable, emailId, attachments) {
  const attachDir = path.resolve(config.attachmentsDir, emailId);
  await fs.promises.mkdir(attachDir, { recursive: true, mode: 0o700 });

  for (const att of attachments) {
    const storageName = buildAttachmentStorageName(att.filename);
    const storagePath = path.join(attachDir, storageName);

    await fs.promises.copyFile(att.tempPath, storagePath, fs.constants.COPYFILE_EXCL);

    await queryable.query(
      `INSERT INTO email_attachments (email_id, filename, content_type, size_bytes, content_id, storage_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [emailId, att.filename, att.contentType, att.size, att.contentId || null, storagePath]
    );
  }
}

async function spoolAttachmentToTemp(att, getTempDir) {
  const filename = sanitizeAttachmentFilename(att.filename) || 'attachment';
  const tempDir = getTempDir();
  await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });

  const tempPath = path.join(tempDir, buildAttachmentStorageName(filename));

  try {
    const writeStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    await pipeline(att.content, writeStream);

    return {
      filename,
      contentType: att.contentType,
      size: att.size,
      contentId: att.contentId || null,
      tempPath,
    };
  } finally {
    if (typeof att.release === 'function') {
      att.release();
    }
  }
}

async function cleanupDirectory(dirPath) {
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, dirPath }, 'Failed to clean up temporary attachment directory');
  }
}

module.exports = { onRcptTo, onData };
