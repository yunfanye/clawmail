const db = require('../db');
const inboxCreationKeyService = require('../services/inboxCreationKeyService');
const { hashSecret } = require('../utils/crypto');
const { UnauthorizedError } = require('../utils/errors');

async function apiKeyCreationAuth(req, _res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    if (!token || token.includes(':')) {
      throw new UnauthorizedError('Invalid auth token format');
    }
    const tokenHash = hashSecret(token);

    const inboxCreationKey = await inboxCreationKeyService.getActiveInboxCreationKey(token);
    if (inboxCreationKey) {
      req.verifiedDomain = {
        id: inboxCreationKey.domain_id,
        domain: inboxCreationKey.domain,
      };
      req.apiKeyCreationAuth = {
        type: 'inbox_creation_key',
        inbox_creation_key_id: inboxCreationKey.id,
      };
      return next();
    }

    const { rows } = await db.query(
      'SELECT id, domain FROM verified_domains WHERE verification_token = $1',
      [tokenHash]
    );

    if (rows.length === 0) {
      throw new UnauthorizedError('Invalid inbox creation key or verification token');
    }

    req.verifiedDomain = rows[0];
    req.apiKeyCreationAuth = { type: 'verification_token' };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = apiKeyCreationAuth;
