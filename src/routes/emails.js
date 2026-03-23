const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const { Router } = require('express');
const config = require('../config');
const inboxAuth = require('../middleware/auth');
const {
  preAuthInboxLimiter,
  inboxSendLimiter,
  inboxOtherLimiter,
} = require('../middleware/inboxRateLimit');
const emailService = require('../services/emailService');
const attachmentRetentionService = require('../services/attachmentRetentionService');
const { BadRequestError, GoneError, NotFoundError } = require('../utils/errors');

const router = Router();
const attachmentRoot = path.resolve(config.attachmentsDir);

function parseAttachmentDownloadFormat(value) {
  const format = String(value || 'auto').trim().toLowerCase();
  if (!['auto', 'zip'].includes(format)) {
    throw new BadRequestError('format must be auto or zip');
  }
  return format;
}

function sanitizeDownloadFilename(filename, fallback = 'attachment') {
  if (typeof filename !== 'string') return fallback;

  const basename = path.posix.basename(filename.replace(/\\/g, '/'));
  const sanitized = basename.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return fallback;
  }

  return sanitized.slice(0, 255);
}

function isWithinAttachmentRoot(filePath) {
  const relative = path.relative(attachmentRoot, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function resolveAttachmentFiles(inboxId, emailId) {
  const attachments = await emailService.listEmailAttachments(inboxId, emailId);

  return Promise.all(attachments.map(async (attachment) => {
    const resolvedPath = path.resolve(attachment.storage_path);
    if (!isWithinAttachmentRoot(resolvedPath)) {
      throw new NotFoundError('Attachment file not found');
    }

    if (attachmentRetentionService.isAttachmentExpired(attachment.created_at)) {
      throw new GoneError('Attachment has expired');
    }

    try {
      await fs.promises.access(resolvedPath, fs.constants.R_OK);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new NotFoundError('Attachment file not found');
      }
      throw err;
    }

    return {
      ...attachment,
      download_filename: sanitizeDownloadFilename(attachment.filename),
      storage_path: resolvedPath,
    };
  }));
}

function buildUniqueArchiveEntryName(filename, usedNames) {
  const safeName = sanitizeDownloadFilename(filename);
  if (!usedNames.has(safeName)) {
    usedNames.add(safeName);
    return safeName;
  }

  const parsed = path.parse(safeName);
  let suffix = 2;
  let candidate = `${parsed.name} (${suffix})${parsed.ext}`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${parsed.name} (${suffix})${parsed.ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

async function streamSingleAttachment(res, attachment) {
  res.attachment(attachment.download_filename);
  res.type(attachment.content_type || 'application/octet-stream');
  if (attachment.size_bytes !== null && attachment.size_bytes !== undefined) {
    res.setHeader('Content-Length', String(attachment.size_bytes));
  }

  await pipeline(fs.createReadStream(attachment.storage_path), res);
}

function streamAttachmentArchive(res, emailId, attachments) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const usedNames = new Set();
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve();
    }

    archive.on('warning', finish);
    archive.on('error', finish);
    res.on('finish', () => finish());
    res.on('close', () => {
      if (!res.writableEnded) {
        archive.abort();
      }
      finish();
    });

    res.attachment(`email-${emailId}-attachments.zip`);
    res.type('application/zip');
    archive.pipe(res);

    for (const attachment of attachments) {
      archive.file(attachment.storage_path, {
        name: buildUniqueArchiveEntryName(attachment.download_filename, usedNames),
      });
    }

    archive.finalize();
  });
}

router.get('/', preAuthInboxLimiter, inboxAuth, inboxOtherLimiter, async (req, res, next) => {
  try {
    const { page, limit, is_archived, is_read } = req.query;
    const result = await emailService.listEmails(req.inbox.id, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      is_archived,
      is_read,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/attachments/download', preAuthInboxLimiter, inboxAuth, inboxOtherLimiter, async (req, res, next) => {
  try {
    const format = parseAttachmentDownloadFormat(req.query.format);
    const attachments = await resolveAttachmentFiles(req.inbox.id, req.params.id);

    if (format === 'zip' || attachments.length > 1) {
      await streamAttachmentArchive(res, req.params.id, attachments);
      return;
    }

    await streamSingleAttachment(res, attachments[0]);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    next(err);
  }
});

router.post('/send', preAuthInboxLimiter, inboxAuth, inboxSendLimiter, async (req, res, next) => {
  try {
    const { to, cc, bcc, subject, text, html } = req.body;
    if (!to) throw new BadRequestError('to is required');
    if (!subject) throw new BadRequestError('subject is required');
    if (!text && !html) throw new BadRequestError('text or html body is required');

    const result = await emailService.sendNewEmail(
      req.inbox.id, req.inbox.domain_id, req.inbox.address,
      { to, cc, bcc, subject, text, html }
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reply', preAuthInboxLimiter, inboxAuth, inboxSendLimiter, async (req, res, next) => {
  try {
    const { text, html, cc, bcc } = req.body;
    if (!text && !html) throw new BadRequestError('text or html body is required');

    const result = await emailService.replyToEmail(
      req.inbox.id, req.inbox.domain_id, req.inbox.address,
      req.params.id, { text, html, cc, bcc }
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/archive', preAuthInboxLimiter, inboxAuth, inboxOtherLimiter, async (req, res, next) => {
  try {
    const result = await emailService.archiveEmail(req.inbox.id, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
