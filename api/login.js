const { PrismaClient } = require('@prisma/client');
const { verifyPassword } = require('../utils/password');
const { createClearedSessionCookie, createSessionCookie } = require('../utils/session');

const prisma = new PrismaClient();

function isJsonRequest(req) {
  return String(req.headers && req.headers.accept || '').includes('application/json') ||
    String(req.headers && req.headers['content-type'] || '').includes('application/json');
}

function respond(req, res, status, payload) {
  if (isJsonRequest(req)) return res.status(status).json(payload);
  if (payload.redirect) return res.redirect(303, payload.redirect);
  return res.status(status).send(payload.error || payload.message);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const body = req.body;
  const email =
    body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return respond(req, res, 400, {
      error: 'Please enter both an email and password.',
    });
  }

  try {
    createSessionCookie('session-secret-check');
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        status: true,
        passwordHash: true,
        emailVerifiedAt: true,
        subscriptions: {
          where: {
            status: 'ACTIVE',
            paymentStatus: 'PAID',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { emailsPer24Hours: true },
        },
      },
    });

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      res.setHeader('Set-Cookie', createClearedSessionCookie());
      return respond(req, res, 401, { error: 'Invalid email or password.' });
    }
    if (user.status === 'SUSPENDED') {
      res.setHeader('Set-Cookie', createClearedSessionCookie());
      return respond(req, res, 403, { error: 'This account is suspended.' });
    }
    if (!user.emailVerifiedAt) {
      res.setHeader('Set-Cookie', createClearedSessionCookie());
      return respond(req, res, 403, {
        error: 'Verify your email before logging in.',
        needsVerification: true,
        email: user.email,
      });
    }

    res.setHeader('Set-Cookie', createSessionCookie(user.id));
    const hasPremiumPlan = user.status === 'ACTIVE' && user.subscriptions.length > 0;
    return respond(req, res, 200, {
      message: hasPremiumPlan
        ? 'Signed in. Your mailer is ready.'
        : 'Signed in. Request a plan or redeem a paid activation code to unlock sending.',
      email: user.email,
      redirect: '/',
    });
  } catch (error) {
    console.error('Login processing error:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return respond(req, res, 500, {
      error: 'Login failed. Please try again later.',
    });
  }
};
