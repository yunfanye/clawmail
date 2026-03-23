const { Router } = require('express');
const domainService = require('../services/domainService');
const domainRegisterAuth = require('../middleware/domainRegisterAuth');
const { BadRequestError } = require('../utils/errors');

const router = Router();

router.post('/register', domainRegisterAuth, async (req, res, next) => {
  try {
    const { domain } = req.body;
    if (!domain || typeof domain !== 'string') {
      throw new BadRequestError('domain is required');
    }
    const result = await domainService.registerDomain(domain);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/verify', async (req, res, next) => {
  try {
    const { verification_token } = req.body;
    if (!verification_token || typeof verification_token !== 'string') {
      throw new BadRequestError('verification_token is required');
    }
    const result = await domainService.verifyDomain(verification_token);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
