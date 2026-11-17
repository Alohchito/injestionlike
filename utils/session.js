const { createHmac, timingSafeEqual } = require('crypto');

const COOKIE_NAME = 'injestionlike_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes.');
  }
  return secret;
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionCookie(userId) {
  const secret = getSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  ).toString('base64url');
  const token = `${payload}.${sign(payload, secret)}`;
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function getSessionUserId(req) {
  const cookieHeader = req.headers && req.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;

  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return null;

  const token = cookie.slice(COOKIE_NAME.length + 1);
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const payload = token.slice(0, separator);
  const suppliedSignature = Buffer.from(token.slice(separator + 1), 'base64url');
  const expectedSignature = Buffer.from(sign(payload, getSessionSecret()), 'base64url');
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      typeof session.sub !== 'string' ||
      !session.sub ||
      !Number.isInteger(session.exp) ||
      session.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return session.sub;
  } catch (error) {
    return null;
  }
}

function createClearedSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = {
  createClearedSessionCookie,
  createSessionCookie,
  getSessionUserId,
};
