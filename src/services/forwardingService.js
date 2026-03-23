const db = require('../db');
const { RE2JS } = require('re2js');
const sender = require('../mail/sender');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger');

const MAX_FORWARDING_REGEX_LENGTH = 1024;

function compileForwardingRegex(pattern) {
  return RE2JS.compile(pattern);
}

function matchesForwardingRegex(regex, value) {
  return regex.matcher(String(value || '')).find();
}

async function createRule(domainId, { match_field, regex_pattern, destination_email }) {
  if (!['from', 'to', 'subject'].includes(match_field)) {
    throw new BadRequestError('match_field must be one of: from, to, subject');
  }
  if (!regex_pattern) throw new BadRequestError('regex_pattern is required');
  if (!destination_email) throw new BadRequestError('destination_email is required');
  if (regex_pattern.length > MAX_FORWARDING_REGEX_LENGTH) {
    throw new BadRequestError(`regex_pattern must be at most ${MAX_FORWARDING_REGEX_LENGTH} characters`);
  }

  // Compile with the RE2 engine up front so catastrophic backtracking syntax is rejected.
  try {
    compileForwardingRegex(regex_pattern);
  } catch {
    throw new BadRequestError('Invalid regex_pattern');
  }

  const { rows } = await db.query(
    `INSERT INTO forwarding_rules (domain_id, match_field, regex_pattern, destination_email)
     VALUES ($1, $2, $3, $4)
     RETURNING id, match_field, regex_pattern, destination_email, is_active, created_at`,
    [domainId, match_field, regex_pattern, destination_email]
  );
  return rows[0];
}

async function listRules(domainId) {
  const { rows } = await db.query(
    'SELECT id, match_field, regex_pattern, destination_email, is_active, created_at FROM forwarding_rules WHERE domain_id = $1 ORDER BY created_at',
    [domainId]
  );
  return rows;
}

async function deleteRule(domainId, ruleId) {
  const { rowCount } = await db.query(
    'DELETE FROM forwarding_rules WHERE id = $1 AND domain_id = $2',
    [ruleId, domainId]
  );
  if (rowCount === 0) throw new NotFoundError('Forwarding rule not found');
}

async function processForwardingRules(domainId, email) {
  const { rows: rules } = await db.query(
    'SELECT id, match_field, regex_pattern, destination_email FROM forwarding_rules WHERE domain_id = $1 AND is_active = true',
    [domainId]
  );

  if (rules.length === 0) return;

  // Get domain info for sending
  const { rows: domainRows } = await db.query('SELECT id, domain FROM verified_domains WHERE id = $1', [domainId]);
  if (domainRows.length === 0) return;
  const domain = domainRows[0].domain;

  for (const rule of rules) {
    let fieldValue;
    switch (rule.match_field) {
      case 'from': fieldValue = email.from; break;
      case 'to': fieldValue = email.to; break;
      case 'subject': fieldValue = email.subject; break;
      default: continue;
    }

    try {
      const regex = compileForwardingRegex(rule.regex_pattern);
      if (matchesForwardingRegex(regex, fieldValue)) {
        logger.info({ ruleId: rule.id, destination: rule.destination_email }, 'Forwarding email');
        // Fire and forget
        sender.sendEmail(domainId, domain, {
          from: `forwarding@${domain}`,
          to: [rule.destination_email],
          subject: `Fwd: ${email.subject || '(no subject)'}`,
          text: email.text || '',
          html: email.html || undefined,
        }).catch(err => {
          logger.error({ err, ruleId: rule.id }, 'Failed to forward email');
        });
      }
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, 'Error evaluating forwarding rule');
    }
  }
}

module.exports = { createRule, listRules, deleteRule, processForwardingRules };
