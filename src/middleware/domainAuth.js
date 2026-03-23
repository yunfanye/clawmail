const db = require('../db');
const { hashSecret } = require('../utils/crypto');
const { UnauthorizedError } = require('../utils/errors');

async function domainAuth(req, _res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    if (!token || token.includes(':')) {
      throw new UnauthorizedError('Invalid verification token format');
    }
    const tokenHash = hashSecret(token);

    const { rows } = await db.query(
      'SELECT id, domain FROM verified_domains WHERE verification_token = $1',
      [tokenHash]
    );

    if (rows.length === 0) {
      throw new UnauthorizedError('Invalid verification token');
    }

    req.verifiedDomain = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = domainAuth;
