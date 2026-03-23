const crypto = require('crypto');
const { encryptAES256GCM, decryptAES256GCM } = require('../utils/crypto');
const config = require('../config');

function generateDkimKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function getPublicKeyForDns(publicKeyPem) {
  const lines = publicKeyPem.split('\n').filter(l => !l.startsWith('-----') && l.trim());
  return lines.join('');
}

function buildDkimDnsRecord(selector, publicKeyPem) {
  const pubKeyBase64 = getPublicKeyForDns(publicKeyPem);
  return `v=DKIM1; k=rsa; p=${pubKeyBase64}`;
}

function encryptPrivateKey(privateKeyPem) {
  return encryptAES256GCM(privateKeyPem, config.dkimEncryptionKey);
}

function decryptPrivateKey(encryptedKey) {
  return decryptAES256GCM(encryptedKey, config.dkimEncryptionKey);
}

function getDkimSelector() {
  return `clawmail${new Date().getFullYear()}`;
}

module.exports = { generateDkimKeyPair, buildDkimDnsRecord, encryptPrivateKey, decryptPrivateKey, getDkimSelector };
