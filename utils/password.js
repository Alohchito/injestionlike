const { promisify } = require('util');
const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('crypto');

const scrypt = promisify(scryptCallback);
const keyLength = 64;

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, keyLength, { maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string') {
    return false;
  }

  const [algorithm, salt, key, extra] = storedHash.split('$');
  if (
    algorithm !== 'scrypt' ||
    !/^[a-f0-9]{32}$/.test(salt || '') ||
    !/^[a-f0-9]{128}$/.test(key || '') ||
    extra !== undefined
  ) {
    return false;
  }

  const expectedKey = Buffer.from(key, 'hex');
  const actualKey = await scrypt(password, salt, keyLength, {
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actualKey, expectedKey);
}

module.exports = { hashPassword, verifyPassword };