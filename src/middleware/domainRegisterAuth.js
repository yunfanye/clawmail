const crypto = require('crypto');
const config = require('../config');
const { UnauthorizedError } = require('../utils/errors');

function domainRegisterAuth(req, _res, next) {
  try {
    if (!config.domainRegisterToken) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const expectedToken = config.domainRegisterToken;

    if (
      !token
      || Buffer.byteLength(token) !== Buffer.byteLength(expectedToken)
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))
    ) {
      throw new UnauthorizedError('Invalid domain register token');
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = domainRegisterAuth;
