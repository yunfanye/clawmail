const nodemailer = require('nodemailer');
const db = require('../db');
const { decryptPrivateKey } = require('./dkim');
const logger = require('../utils/logger');

const transport = nodemailer.createTransport({ direct: true });

async function getDkimConfig(domainId, domain) {
  const { rows } = await db.query(
    'SELECT selector, private_key FROM dkim_keys WHERE domain_id = $1 AND active = true LIMIT 1',
    [domainId]
  );
  if (rows.length === 0) return null;

  const privateKey = decryptPrivateKey(rows[0].private_key);
  return {
    domainName: domain,
    keySelector: rows[0].selector,
    privateKey,
  };
}

async function sendEmail(domainId, domain, { from, to, cc, bcc, subject, text, html, inReplyTo, references, messageId }) {
  const dkim = await getDkimConfig(domainId, domain);

  const mailOptions = {
    from,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    text,
    html,
    messageId,
  };

  if (cc) mailOptions.cc = Array.isArray(cc) ? cc.join(', ') : cc;
  if (bcc) mailOptions.bcc = Array.isArray(bcc) ? bcc.join(', ') : bcc;
  if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
  if (references) mailOptions.references = Array.isArray(references) ? references.join(' ') : references;

  if (dkim) {
    mailOptions.dkim = dkim;
  }

  const info = await transport.sendMail(mailOptions);
  logger.info({ messageId: info.messageId, from, to }, 'Email sent');
  return info;
}

module.exports = { sendEmail };
