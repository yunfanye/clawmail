require('dotenv').config();

function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;

  const normalized = String(value).trim().toLowerCase();
  if (['false', 'no', 'off'].includes(normalized)) return false;
  if (['true', 'yes', 'on'].includes(normalized)) return true;
  if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);

  return value;
}

function deriveFromAppDomain(value, derive) {
  if (value) return value;

  const appDomain = process.env.APP_DOMAIN || '';
  if (!appDomain) return '';

  return derive(appDomain);
}

function parseInboxRateLimitScope(value) {
  const normalized = String(value || 'ip').trim().toLowerCase();
  return normalized === 'email' ? 'email' : 'ip';
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCatchAllLocalPart(value) {
  const normalized = String(value || 'catchall').trim().toLowerCase();
  return normalized || 'catchall';
}

const attachmentTtlHours = parseOptionalPositiveInt(process.env.ATTACHMENT_TTL_HOURS);
const attachmentTtlMs = attachmentTtlHours ? attachmentTtlHours * 60 * 60 * 1000 : null;
const attachmentCleanupIntervalMs = 3 * 60 * 60 * 1000;

module.exports = {
  port: parsePositiveInt(process.env.PORT, 3000),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  inboxRateLimitScope: parseInboxRateLimitScope(process.env.INBOX_RATE_LIMIT_SCOPE),
  inboxRateLimitWindowMs: 60 * 60 * 1000,
  inboxSendRateLimitMax: 10,
  inboxOtherRateLimitMax: 100,
  inboxStorageQuotaBytes: parsePositiveInt(process.env.INBOX_STORAGE_QUOTA_BYTES, 500 * 1024 * 1024),
  catchAllLocalPart: parseCatchAllLocalPart(process.env.CATCH_ALL_LOCAL_PART),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://clawmail:clawmail@localhost:5432/clawmail',
  dkimEncryptionKey: process.env.DKIM_ENCRYPTION_KEY || '',
  domainRegisterToken: process.env.DOMAIN_REGISTER_TOKEN || '',
  serverIp: process.env.SERVER_IP || '203.0.113.10',
  mxServerDomainName: process.env.MX_SERVER_DOMAIN_NAME || 'mx',
  smtpBannerHostname: deriveFromAppDomain(process.env.SMTP_BANNER_HOSTNAME, (appDomain) => `mx.${appDomain}`),
  smtpPort: parsePositiveInt(process.env.SMTP_PORT, 25),
  smtpTlsKeyPath: process.env.SMTP_TLS_KEY_PATH || '',
  smtpTlsCertPath: process.env.SMTP_TLS_CERT_PATH || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  nodeEnv: process.env.NODE_ENV || 'development',
  attachmentsDir: process.env.ATTACHMENTS_DIR || './attachments',
  attachmentTtlMs,
  attachmentCleanupIntervalMs,
};
