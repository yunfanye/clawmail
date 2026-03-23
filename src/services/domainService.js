const db = require('../db');
const config = require('../config');
const { generateToken, hashSecret } = require('../utils/crypto');
const { generateDkimKeyPair, buildDkimDnsRecord, encryptPrivateKey, getDkimSelector } = require('../mail/dkim');
const dnsService = require('./dnsService');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');

async function registerDomain(domain) {
  domain = domain.toLowerCase().trim();

  const existing = await db.query('SELECT id FROM verified_domains WHERE domain = $1', [domain]);
  if (existing.rows.length > 0) {
    throw new ConflictError('Domain is already verified');
  }

  const token = generateToken(32);
  const tokenHash = hashSecret(token);
  const verifyValue = `clawmail-verify=${generateToken(16)}`;

  await db.query(
    `INSERT INTO pending_domains (domain, verification_token, dns_txt_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (domain) DO UPDATE SET
       verification_token = EXCLUDED.verification_token,
       dns_txt_value = EXCLUDED.dns_txt_value,
       expires_at = NOW() + INTERVAL '72 hours'`,
    [domain, tokenHash, verifyValue]
  );

  return {
    verification_token: token,
    dns_txt_record: `_clawmail.${domain}`,
    dns_txt_value: verifyValue,
    mx_record: `${config.mxServerDomainName}.${domain}`,
    a_record: { name: `${config.mxServerDomainName}.${domain}`, value: config.serverIp },
  };
}

async function verifyDomain(verificationToken) {
  const verificationTokenHash = hashSecret(verificationToken);
  const pending = await db.query(
    'SELECT id, domain, dns_txt_value FROM pending_domains WHERE verification_token = $1 AND expires_at > NOW()',
    [verificationTokenHash]
  );
  if (pending.rows.length === 0) {
    throw new NotFoundError('Invalid or expired verification token');
  }

  const { domain, dns_txt_value } = pending.rows[0];

  const dnsResult = await dnsService.verifyAllRecords(domain, dns_txt_value);
  if (!dnsResult.allPassed) {
    throw new BadRequestError(
      `DNS verification failed. TXT: ${dnsResult.txt ? 'OK' : 'FAIL'}, MX: ${dnsResult.mx ? 'OK' : 'FAIL'}, A: ${dnsResult.a ? 'OK' : 'FAIL'}`
    );
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO verified_domains (domain, verification_token)
       VALUES ($1, $2)
       ON CONFLICT (domain) DO NOTHING
       RETURNING id`,
      [domain, verificationTokenHash]
    );

    let domainId;
    if (rows.length > 0) {
      domainId = rows[0].id;
    } else {
      const existing = await client.query('SELECT id FROM verified_domains WHERE domain = $1', [domain]);
      domainId = existing.rows[0].id;
    }

    const selector = getDkimSelector();
    const { publicKey, privateKey } = generateDkimKeyPair();
    const encryptedPrivateKey = encryptPrivateKey(privateKey);
    const dnsRecord = buildDkimDnsRecord(selector, publicKey);

    await client.query(
      `INSERT INTO dkim_keys (domain_id, selector, private_key, public_key, dns_txt_record, active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [domainId, selector, encryptedPrivateKey, publicKey, dnsRecord]
    );

    await client.query('DELETE FROM pending_domains WHERE domain = $1', [domain]);
    await client.query('COMMIT');

    return {
      domain,
      verified: true,
      dkim: {
        selector,
        dns_record_name: `${selector}._domainkey.${domain}`,
        dns_record_value: dnsRecord,
      },
      message: `Domain verified. Please add a TXT record for ${selector}._domainkey.${domain} with the value above to enable DKIM email signing.`,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { registerDomain, verifyDomain };
