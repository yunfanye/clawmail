const apiKeyService = require('../services/apiKeyService');
const { UnauthorizedError } = require('../utils/errors');

async function inboxAuth(req, _res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const colonIndex = token.indexOf(':');
    if (colonIndex === -1) {
      throw new UnauthorizedError('Invalid auth format. Expected email:api_key');
    }

    const email = token.substring(0, colonIndex);
    const apiKey = token.substring(colonIndex + 1);

    const result = await apiKeyService.validateApiKey(email, apiKey);
    if (!result) {
      throw new UnauthorizedError('Invalid email or API key');
    }

    req.inbox = { id: result.inbox_id, address: result.address, domain_id: result.domain_id };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = inboxAuth;
