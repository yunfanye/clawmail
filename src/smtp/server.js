const fs = require('fs');
const { SMTPServer } = require('smtp-server');
const config = require('../config');
const logger = require('../utils/logger');
const { onRcptTo, onData } = require('./handlers');

function getTlsOptions() {
  const hasKeyPath = Boolean(config.smtpTlsKeyPath);
  const hasCertPath = Boolean(config.smtpTlsCertPath);

  if (hasKeyPath !== hasCertPath) {
    throw new Error('SMTP_TLS_KEY_PATH and SMTP_TLS_CERT_PATH must be set together');
  }

  if (hasKeyPath && hasCertPath) {
    return {
      key: fs.readFileSync(config.smtpTlsKeyPath),
      cert: fs.readFileSync(config.smtpTlsCertPath),
    };
  }

  if (config.nodeEnv === 'production') {
    throw new Error('SMTP TLS is required in production. Set SMTP_TLS_KEY_PATH and SMTP_TLS_CERT_PATH');
  }

  logger.warn(
    'SMTP TLS certificate paths are not configured; using smtp-server development defaults for STARTTLS'
  );
  return {};
}

function startSmtpServer() {
  const tlsOptions = getTlsOptions();
  const server = new SMTPServer({
    secure: false,
    authOptional: true,
    size: 25 * 1024 * 1024, // 25MB
    disabledCommands: ['AUTH'],
    onRcptTo,
    onData,
    logger: false,
    ...(config.smtpBannerHostname ? { name: config.smtpBannerHostname } : {}),
    ...tlsOptions,
  });

  server.on('error', (err) => {
    if (err.code === 'EACCES' && config.smtpPort < 1024) {
      logger.error(
        { err, port: config.smtpPort },
        'SMTP port requires elevated privileges. Use a port >= 1024 (for example 2525) or grant bind permission to the process'
      );
      return;
    }

    logger.error({ err }, 'SMTP server error');
  });

  server.listen(config.smtpPort, () => {
    logger.info({ port: config.smtpPort }, 'SMTP server listening');
  });

  return server;
}

module.exports = { startSmtpServer };
