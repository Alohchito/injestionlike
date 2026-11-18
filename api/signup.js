const { createHmac, randomInt, timingSafeEqual } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('../utils/password');
const { parseRequestBody } = require('../utils/request-body');
const { createSessionCookie } = require('../utils/session');
const { sendEmail } = require('../utils/email');

const prisma = new PrismaClient();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function hashVerificationCode(userId, code) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes.');
  }
  return createHmac('sha256', secret)
    .update(`${userId}:${code}`)
    .digest('hex');
}

function isTestCodeMode() {
  const nonProduction =
    process.env.VERCEL_ENV
      ? process.env.VERCEL_ENV !== 'production'
      : process.env.NODE_ENV !== 'production';
  return nonProduction && process.env.TEST_MODE_VERIFICATION_CODE === 'true';
}

function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBody(req) {
  return parseRequestBody(
    req.body,
    String((req.headers && req.headers['content-type']) || ''),
  );
}

async function createPendingAccount(res, body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter both an email and password.' });
  }
  if (email.length > 254 || !emailPattern.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
  }
  if (!isTestCodeMode() && (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)) {
    return res.status(503).json({
      error: 'Email verification is not configured. Please try again later.',
    });
  }

  let stage = 'password hashing';
  try {
    const code = String(randomInt(0, 1000000)).padStart(6, '0').trim();
    const passwordHash = await hashPassword(password);
    stage = 'pending user insert';
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          status: 'PENDING',
          emailVerificationSentAt: new Date(),
          emailVerificationExpiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
        select: { id: true, email: true },
      });
      await tx.$executeRaw`
        INSERT INTO public.profiles (user_id, role)
        VALUES (
          ${created.id},
          CASE
            WHEN ${Boolean(process.env.ADMIN_EMAIL)} = true
              AND lower(${process.env.ADMIN_EMAIL || ''}) = lower(${created.email})
            THEN 'ADMIN'
            ELSE 'USER'
          END
        )
        ON CONFLICT (user_id) DO UPDATE SET
          role = CASE
            WHEN ${Boolean(process.env.ADMIN_EMAIL)} = true
              AND lower(${process.env.ADMIN_EMAIL || ''}) = lower(${created.email})
            THEN 'ADMIN'
            ELSE public.profiles.role
          END
      `;
      stage = 'verification code persistence';
      await tx.user.update({
        where: { id: created.id },
        data: { emailVerificationCodeHash: hashVerificationCode(created.id, code) },
      });
      return created;
    });

    if (!isTestCodeMode()) {
      stage = 'verification email delivery';
      await sendEmail({
        to: user.email,
        subject: 'Verify your Injestionlike email address',
        text: `Your verification code is ${code}. It expires in 15 minutes. If you did not create an account, ignore this message.`,
        html: `<p>Your Injestionlike verification code is <strong>${code}</strong>.</p><p>It expires in 15 minutes. If you did not create an account, ignore this message.</p>`,
      });
    }

    const response = {
      message: 'Account created. Enter the verification code to continue.',
      verificationRequired: true,
    };
    if (isTestCodeMode()) {
      console.log('TEST MODE VERIFICATION CODE:', code);
      response.testVerificationCode = code;
    }
    return res.status(201).json(response);
  } catch (error) {
    console.error('Sign-up account persistence failed:', {
      stage,
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
      meta: error && error.meta,
    });
    throw error;
  }
}

async function resendVerificationEmail(res, body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!emailPattern.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isTestCodeMode() && (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)) {
    return res.status(503).json({ error: 'Email verification is not configured.' });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      emailVerifiedAt: true,
      emailVerificationSentAt: true,
      emailVerificationAttempts: true,
    },
  });
  if (!user || user.emailVerifiedAt) {
    return res.status(200).json({
      message: 'If this address has an unverified account, a new code can be requested.',
    });
  }
  const now = new Date();
  if (
    user.emailVerificationAttempts >= MAX_CODE_ATTEMPTS ||
    (user.emailVerificationSentAt &&
      now.getTime() - user.emailVerificationSentAt.getTime() < RESEND_COOLDOWN_MS)
  ) {
    return res.status(429).json({ error: 'Please wait before requesting another verification code.' });
  }

  const code = String(randomInt(0, 1000000)).padStart(6, '0').trim();
  const updated = await prisma.user.updateMany({
    where: {
      id: user.id,
      emailVerifiedAt: null,
      emailVerificationAttempts: { lt: MAX_CODE_ATTEMPTS },
      OR: [
        { emailVerificationSentAt: null },
        { emailVerificationSentAt: { lte: new Date(now.getTime() - RESEND_COOLDOWN_MS) } },
      ],
    },
    data: {
      emailVerificationCodeHash: hashVerificationCode(user.id, code),
      emailVerificationExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
      emailVerificationSentAt: now,
    },
  });
  if (updated.count !== 1) {
    return res.status(429).json({ error: 'Please wait before requesting another verification code.' });
  }

  if (isTestCodeMode()) {
    console.log('TEST MODE VERIFICATION CODE:', code);
    return res.status(200).json({
      message: 'A new verification code is ready.',
      testVerificationCode: code,
    });
  }
  await sendEmail({
    to: user.email,
    subject: 'Your new Injestionlike verification code',
    text: `Your new verification code is ${code}. It expires in 15 minutes. If you did not request this, ignore this message.`,
    html: `<p>Your new Injestionlike verification code is <strong>${code}</strong>.</p><p>It expires in 15 minutes. If you did not request this, ignore this message.</p>`,
  });
  return res.status(200).json({ message: 'A new verification code has been sent.' });
}

async function verifyPendingAccount(res, body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = String(body.code ?? '').trim();
  if (!emailPattern.test(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a valid email and six-digit code.' });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      emailVerifiedAt: true,
      emailVerificationCodeHash: true,
      emailVerificationExpiresAt: true,
      emailVerificationAttempts: true,
    },
  });
  if (!user || user.emailVerifiedAt) {
    if (user && user.emailVerifiedAt) {
      return res.status(409).json({ error: 'This email is already verified. Please log in.' });
    }
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  if (
    !user.emailVerificationExpiresAt ||
    user.emailVerificationExpiresAt <= new Date() ||
    user.emailVerificationAttempts >= MAX_CODE_ATTEMPTS
  ) {
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  const expectedHash = hashVerificationCode(user.id, code);
  if (!equalHash(user.emailVerificationCodeHash, expectedHash)) {
    await prisma.user.updateMany({
      where: { id: user.id, emailVerificationAttempts: { lt: MAX_CODE_ATTEMPTS } },
      data: { emailVerificationAttempts: { increment: 1 } },
    });
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  const verifiedAt = new Date();
  const updated = await prisma.user.updateMany({
    where: {
      id: user.id,
      emailVerifiedAt: null,
      emailVerificationCodeHash: user.emailVerificationCodeHash,
      emailVerificationExpiresAt: { gt: verifiedAt },
      emailVerificationAttempts: { lt: MAX_CODE_ATTEMPTS },
    },
    data: {
      emailVerifiedAt: verifiedAt,
      emailVerificationCodeHash: null,
      emailVerificationExpiresAt: null,
      emailVerificationAttempts: 0,
    },
  });
  if (updated.count !== 1) {
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  res.setHeader('Set-Cookie', createSessionCookie(user.id));
  return res.status(200).json({
    message: 'Email verified. You are now signed in.',
    email: user.email,
    redirect: '/',
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  let body;
  try {
    body = parseBody(req);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid sign-up request body.' });
  }

  try {
    createSessionCookie('session-secret-check');
  } catch (error) {
    console.error('Sign-up session configuration error:', error.message);
    return res.status(500).json({ error: 'Account sessions are not configured.' });
  }

  try {
    if (body.action === 'verify') {
      return await verifyPendingAccount(res, body);
    }
    if (body.action === 'resend') {
      return await resendVerificationEmail(res, body);
    }
    if (body.action && body.action !== 'signup') {
      return res.status(400).json({ error: 'Unsupported sign-up action.' });
    }

    return await createPendingAccount(res, body);
  } catch (error) {
    if (error && error.code === 'P2002') {
      return res.status(409).json({
        error: 'An account with this email already exists. Please log in.',
      });
    }
    console.error('Sign-up processing failed:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Account creation could not be completed.' });
  }
};

module.exports.hashVerificationCode = hashVerificationCode;
