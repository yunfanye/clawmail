const { Router } = require('express');
const apiKeyCreationAuth = require('../middleware/apiKeyCreationAuth');
const apiKeyService = require('../services/apiKeyService');
const { BadRequestError } = require('../utils/errors');

const router = Router();

router.post('/', apiKeyCreationAuth, async (req, res, next) => {
  try {
    const { email, label } = req.body;
    if (!email || typeof email !== 'string') {
      throw new BadRequestError('email is required');
    }
    const result = await apiKeyService.createApiKey(
      req.verifiedDomain.id,
      req.verifiedDomain.domain,
      email,
      label,
      { inboxCreationKeyId: req.apiKeyCreationAuth.inbox_creation_key_id }
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
