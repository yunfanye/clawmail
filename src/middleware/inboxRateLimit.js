const rateLimit = require('express-rate-limit');
const config = require('../config');

function getInboxRateLimitKey(req) {
  return req.inbox?.address?.toLowerCase() || req.ip;
}

function createInboxRateLimiter({ max, message }) {
  const options = {
    windowMs: config.inboxRateLimitWindowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message,
  };

  if (config.inboxRateLimitScope === 'email') {
    options.keyGenerator = getInboxRateLimitKey;
  }

  return rateLimit(options);
}

const inboxSendLimiter = createInboxRateLimiter({
  max: config.inboxSendRateLimitMax,
  message: { error: 'Too many send requests, try again later' },
});

const inboxOtherLimiter = createInboxRateLimiter({
  max: config.inboxOtherRateLimitMax,
  message: { error: 'Too many inbox requests, try again later' },
});

const preAuthInboxLimiter = rateLimit({
  // Coarse IP-based limiter for failed auth traffic before req.inbox is available.
  windowMs: config.inboxRateLimitWindowMs,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, try again later' },
});

module.exports = {
  createInboxRateLimiter,
  preAuthInboxLimiter,
  inboxSendLimiter,
  inboxOtherLimiter,
};
