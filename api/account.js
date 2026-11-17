const { PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');

const prisma = new PrismaClient();

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  let userId;
  try {
    userId = getSessionUserId(req);
  } catch (error) {
    console.error('Account session configuration error:', error.message);
    return res.status(500).json({ error: 'Account session is not configured.' });
  }
  if (!userId) return res.status(401).json({ error: 'Please log in.' });

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        status: true,
        emailVerifiedAt: true,
        subscriptions: {
          where: {
            status: 'ACTIVE',
            paymentStatus: 'PAID',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, emailsPer24Hours: true, durationMonths: true, expiresAt: true },
        },
      },
    });
    if (!user || user.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account cannot be accessed.' });
    }
    const subscription = user.subscriptions[0] || null;
    const usage = subscription
      ? await prisma.quotaLedger.count({
          where: {
            userId,
            status: { in: ['RESERVED', 'SENT'] },
            reservedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        })
      : 0;
    const profiles = await prisma.$queryRaw`
      SELECT role FROM public.profiles WHERE user_id = ${userId}
    `;
    return res.status(200).json({
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      status: user.status,
      isAdmin: profiles.length > 0 && profiles[0].role === 'ADMIN',
      subscription: subscription
        ? {
            ...subscription,
            batchLimit: subscription.emailsPer24Hours / 10,
            usedLast24Hours: usage,
            remainingLast24Hours: Math.max(0, subscription.emailsPer24Hours - usage),
          }
        : null,
    });
  } catch (error) {
    console.error('Account lookup failed:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Account details could not be loaded.' });
  }
};
