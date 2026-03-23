const { Router } = require('express');
const domainAuth = require('../middleware/domainAuth');
const inboxCreationKeyService = require('../services/inboxCreationKeyService');

const router = Router();

router.post('/', domainAuth, async (req, res, next) => {
  try {
    const result = await inboxCreationKeyService.createInboxCreationKey(req.verifiedDomain.id);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
