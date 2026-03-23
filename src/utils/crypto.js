const crypto = require('crypto');

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateApiKey() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `cm_${raw}`;
}

function generateInboxCreationKey() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `cmic_${raw}`;
}

function hashApiKey(key) {
  return hashSecret(key);
}

function getKeyPrefix(key) {
  return key.substring(0, 12);
}

function encryptAES256GCM(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptAES256GCM(ciphertext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
}

module.exports = {
  generateToken,
  hashSecret,
  generateApiKey,
  generateInboxCreationKey,
  hashApiKey,
  getKeyPrefix,
  encryptAES256GCM,
  decryptAES256GCM,
};
