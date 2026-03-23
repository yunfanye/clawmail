const { Router } = require('express');
const domainAuth = require('../middleware/domainAuth');
const inboxService = require('../services/inboxService');

const router = Router();

router.get('/', domainAuth, async (req, res, next) => {
  try {
    const inboxes = await inboxService.listInboxes(req.verifiedDomain.id);
    res.json({ inboxes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
