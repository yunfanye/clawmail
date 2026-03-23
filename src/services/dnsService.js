const dns = require('dns').promises;
const config = require('../config');
const logger = require('../utils/logger');

async function checkTxtRecord(domain, expectedValue) {
  try {
    const records = await dns.resolveTxt(`_clawmail.${domain}`);
    const flat = records.map(r => r.join(''));
    return flat.some(r => r === expectedValue);
  } catch (err) {
    logger.debug({ err, domain }, 'TXT record lookup failed');
    return false;
  }
}

async function checkMxRecord(domain) {
  try {
    const expectedExchange = `${config.mxServerDomainName}.${domain}`;
    const records = await dns.resolveMx(domain);
    return records.some(mx => mx.exchange.toLowerCase() === expectedExchange.toLowerCase());
  } catch (err) {
    logger.debug({ err, domain }, 'MX record lookup failed');
    return false;
  }
}

async function checkARecord(domain) {
  try {
    const mxHost = `${config.mxServerDomainName}.${domain}`;
    const addresses = await dns.resolve4(mxHost);
    return addresses.includes(config.serverIp);
  } catch (err) {
    logger.debug({ err, domain }, 'A record lookup failed');
    return false;
  }
}

async function verifyAllRecords(domain, expectedTxtValue) {
  const [txt, mx, a] = await Promise.all([
    checkTxtRecord(domain, expectedTxtValue),
    checkMxRecord(domain),
    checkARecord(domain),
  ]);
  return { txt, mx, a, allPassed: txt && mx && a };
}

module.exports = { checkTxtRecord, checkMxRecord, checkARecord, verifyAllRecords };
