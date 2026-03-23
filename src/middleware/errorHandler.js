const logger = require('../utils/logger');

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal server error';

  if (statusCode >= 500) {
    logger.error({ err, method: req.method, url: req.url }, 'Server error');
  } else {
    logger.warn({ statusCode, message, method: req.method, url: req.url }, 'Client error');
  }

  res.status(statusCode).json({ error: message });
}

module.exports = errorHandler;
