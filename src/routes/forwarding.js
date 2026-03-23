const { Router } = require('express');
const domainAuth = require('../middleware/domainAuth');
const forwardingService = require('../services/forwardingService');
const { BadRequestError } = require('../utils/errors');

const router = Router();

router.post('/', domainAuth, async (req, res, next) => {
  try {
    const { match_field, regex_pattern, destination_email } = req.body;
    if (!match_field) throw new BadRequestError('match_field is required');
    if (!regex_pattern) throw new BadRequestError('regex_pattern is required');
    if (!destination_email) throw new BadRequestError('destination_email is required');

    const rule = await forwardingService.createRule(req.verifiedDomain.id, {
      match_field, regex_pattern, destination_email,
    });
    res.status(201).json(rule);
  } catch (err) {
    next(err);
  }
});

router.get('/', domainAuth, async (req, res, next) => {
  try {
    const rules = await forwardingService.listRules(req.verifiedDomain.id);
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', domainAuth, async (req, res, next) => {
  try {
    await forwardingService.deleteRule(req.verifiedDomain.id, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
