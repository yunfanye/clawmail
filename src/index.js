const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const domainRoutes = require('./routes/domains');
const apikeyRoutes = require('./routes/apikeys');
const inboxCreationKeyRoutes = require('./routes/inboxCreationKeys');
const inboxRoutes = require('./routes/inboxes');
const emailRoutes = require('./routes/emails');
const forwardingRoutes = require('./routes/forwarding');
const { startAttachmentExpirationJob } = require('./services/attachmentRetentionService');
const { startSmtpServer } = require('./smtp/server');

const app = express();

app.set('trust proxy', config.trustProxy);
app.use(helmet());
app.use(express.json({ limit: '25mb' }));

// Rate limiters
const domainRegLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many domain registration requests, try again later' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many read requests, try again later' },
});

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clawmail</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { margin-bottom: 0.25em; }
  h2 { margin-top: 1.5em; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f0f0f0; padding: 12px 16px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  a { color: #0066cc; }
  ol li { margin-bottom: 0.75em; }
  .subtitle { color: #555; margin-top: 0; }
</style>
</head>
<body>
<h1>Clawmail</h1>
<p class="subtitle">Agent-oriented email system</p>

<h2>Getting Started</h2>
<ol>
  <li><strong>Register your domain</strong><br>
    <pre><code>POST /api/v1/domains/register
{ "domain": "clawmail.org" }</code></pre>
    If <code>DOMAIN_REGISTER_TOKEN</code> is configured, include
    <code>Authorization: Bearer &lt;DOMAIN_REGISTER_TOKEN&gt;</code>.
    Re-running registration for the same unverified domain rotates the pending verification token and TXT value.
    You'll receive DNS records to configure:
    <ul>
      <li><code>TXT</code> &mdash; <code>_clawmail.clawmail.org</code> &rarr; verification value</li>
      <li><code>MX</code> &mdash; <code>clawmail.org</code> &rarr; <code>mx.clawmail.org</code> (priority 10)</li>
      <li><code>A</code> &mdash; <code>mx.clawmail.org</code> &rarr; your server IP</li>
    </ul>
  </li>

  <li><strong>Verify your domain</strong><br>
    After setting DNS records:
    <pre><code>POST /api/v1/domains/verify
{ "verification_token": "&lt;token&gt;" }</code></pre>
    Add the returned DKIM record to DNS for outbound email signing.</li>

  <li><strong>Create an inbox creation key</strong> (domain auth required)<br>
    <pre><code>POST /api/v1/inbox-creation-keys
Authorization: Bearer &lt;verification_token&gt;</code></pre>
    The returned <code>inbox_creation_key</code> can be used once to create an inbox API key.</li>

  <li><strong>Create an API key</strong> (one-time inbox creation key or domain auth)<br>
    <pre><code>POST /api/v1/api-keys
Authorization: Bearer &lt;inbox_creation_key&gt;
{ "email": "agent@clawmail.org", "label": "my-agent" }</code></pre>
    This route also accepts <code>Bearer &lt;verification_token&gt;</code>. Save the returned <code>api_key</code> &mdash; it is shown only once.</li>

  <li><strong>Send and receive email</strong> (inbox auth required)<br>
    <pre><code>Authorization: Bearer agent@clawmail.org:cm_&lt;key&gt;</code></pre>
    <ul>
      <li><code>GET  /api/v1/emails</code> &mdash; list emails</li>
      <li><code>GET  /api/v1/emails/:id/attachments/download?format=auto|zip</code> &mdash; download attachments</li>
      <li><code>POST /api/v1/emails/send</code> &mdash; send an email</li>
      <li><code>POST /api/v1/emails/:id/reply</code> &mdash; reply</li>
      <li><code>POST /api/v1/emails/:id/archive</code> &mdash; archive</li>
    </ul>
  </li>
</ol>

<h2>Other Endpoints</h2>
<ul>
  <li><code>GET /api/v1/inboxes</code> &mdash; list inboxes (domain auth)</li>
  <li><code>POST /api/v1/inbox-creation-keys</code> &mdash; create a one-time inbox creation key (domain auth)</li>
  <li><code>POST /api/v1/forwarding-rules</code> &mdash; create forwarding rule (domain auth)</li>
  <li><code>GET /api/v1/forwarding-rules</code> &mdash; list forwarding rules (domain auth)</li>
  <li><code>DELETE /api/v1/forwarding-rules/:id</code> &mdash; delete rule (domain auth)</li>
  <li><code>GET /health</code> &mdash; health check</li>
</ul>

<h2>Email Deliverability</h2>
<p>To ensure outbound emails pass spam filters, add these DNS records for each domain:</p>
<ul>
  <li><strong>SPF</strong> &mdash; TXT record on <code>clawmail.org</code>:<br>
    <code>v=spf1 a:mx.clawmail.org -all</code></li>
  <li><strong>DMARC</strong> &mdash; TXT record on <code>_dmarc.clawmail.org</code>:<br>
    <code>v=DMARC1; p=none; rua=mailto:dmarc@clawmail.org</code></li>
  <li><strong>DKIM</strong> &mdash; TXT record returned by <code>/api/v1/domains/verify</code></li>
  <li><strong>rDNS (PTR)</strong> &mdash; Set reverse DNS for your server IP to match <code>mx.clawmail.org</code> via your hosting provider (e.g. Vultr: Server Settings &rarr; IPv4 &rarr; edit). The A record, PTR, and <code>SMTP_BANNER_HOSTNAME</code> env var must all resolve to the same hostname.</li>
</ul>

<h2>Full API Reference</h2>
<p>See <a href="/api.md">/api.md</a> for complete request/response examples.</p>

<h2>Agent Operations</h2>
<p>See <a href="/skills.md">/skills.md</a> for the agent-facing operations guide.</p>
</body>
</html>`);
});

function serveMarkdownDoc(res, fileName) {
  const filePath = path.join(__dirname, '..', fileName);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      logger.error({ err, fileName }, 'Failed to read markdown documentation');
      return res.status(500).json({ error: 'Failed to read documentation' });
    }
    res.type('text/markdown').send(data);
  });
}

app.get('/api.md', (_req, res) => {
  serveMarkdownDoc(res, 'API.md');
});

app.get('/skills.md', (_req, res) => {
  serveMarkdownDoc(res, 'SKILLS.md');
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v1/domains', domainRegLimiter, domainRoutes);
app.use('/api/v1/inbox-creation-keys', readLimiter, inboxCreationKeyRoutes);
app.use('/api/v1/api-keys', readLimiter, apikeyRoutes);
app.use('/api/v1/inboxes', readLimiter, inboxRoutes);
app.use('/api/v1/emails', emailRoutes);
app.use('/api/v1/forwarding-rules', readLimiter, forwardingRoutes);

app.use(errorHandler);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Express server listening');
});

startAttachmentExpirationJob();
startSmtpServer();
