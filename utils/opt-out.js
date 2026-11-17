const { createCipheriv, createDecipheriv, createHmac, randomBytes } = require('crypto');

function getEncryptionKey() {
  const secret = process.env.ACTIVATION_CODE_SECRET || process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('ACTIVATION_CODE_SECRET or a 32-byte SESSION_SECRET is required.');
  }
  return createHmac('sha256', secret).update('recipient-opt-out').digest();
}

function createOptOutToken({ senderUserId, senderEmail, recipientEmail }) {
  if (!senderUserId || !senderEmail || !recipientEmail) {
    throw new TypeError('Sender and recipient details are required for an opt-out token.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({
      senderUserId,
      senderEmail: senderEmail.trim().toLowerCase(),
      recipientEmail: recipientEmail.trim().toLowerCase(),
    })),
    cipher.final(),
  ]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

function readOptOutToken(token) {
  if (typeof token !== 'string') throw new TypeError('Opt-out token is invalid.');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new TypeError('Opt-out token is invalid.');
  }
  const key = getEncryptionKey();
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[0], 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const details = JSON.parse(plaintext);
    if (
      typeof details.senderUserId !== 'string' ||
      typeof details.senderEmail !== 'string' ||
      typeof details.recipientEmail !== 'string' ||
      !details.senderUserId ||
      !details.senderEmail ||
      !details.recipientEmail
    ) {
      throw new TypeError('Opt-out token is invalid.');
    }
    return details;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Opt-out token is invalid.');
  }
}

module.exports = { createOptOutToken, readOptOutToken };
