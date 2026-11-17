const { Prisma, PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');
const { parseRequestBody } = require('../utils/request-body');

const prisma = new PrismaClient();
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function parseAddressList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const addresses = value.split(',').map((address) => address.trim().toLowerCase());
  if (addresses.length > 1000 || addresses.some((address) => !emailPattern.test(address))) {
    throw new TypeError('Recipient addresses are invalid.');
  }
  return addresses;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let userId;
  try {
    userId = getSessionUserId(req);
  } catch (error) {
    console.error('Mailer session configuration error:', error.message);
    return res.status(500).json({ error: 'Mailer is not configured.' });
  }
  if (!userId) return res.status(401).json({ error: 'Please log in.' });

  let body;
  try {
    body = parseRequestBody(
      req.body,
      String((req.headers && req.headers['content-type']) || ''),
    );
    if (
      typeof body.from !== 'string' ||
      typeof body.subject !== 'string' ||
      typeof body.body !== 'string' ||
      /[\r\n]/.test(body.from) ||
      /[\r\n]/.test(body.subject) ||
      body.subject.length > 998 ||
      body.body.length > 100000
    ) {
      throw new TypeError('Message fields are invalid.');
    }
    body.recipients = {
      to: parseAddressList(body.to),
      cc: parseAddressList(body.cc),
      bcc: parseAddressList(body.bcc),
    };
    if (!body.recipients.to.length) throw new TypeError('At least one To recipient is required.');
    if (
      body.replyTo &&
      (typeof body.replyTo !== 'string' || !emailPattern.test(body.replyTo.trim()))
    ) {
      throw new TypeError('Reply-To address is invalid.');
    }
    if (body.recipientConsent !== true && body.recipientConsent !== 'true' &&
        body.recipientConsent !== 'on') {
      throw new TypeError('Confirm that every recipient has consented before sending.');
    }
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid message.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        emailVerifiedAt: true,
        subscriptions: {
          where: {
            status: 'ACTIVE',
            paymentStatus: 'PAID',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          take: 1,
          orderBy: { expiresAt: 'desc' },
          select: { id: true, emailsPer24Hours: true, expiresAt: true },
        },
      },
    });
    if (!user || user.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account cannot send messages.' });
    }
    if (!user.emailVerifiedAt || !user.subscriptions.length) {
      return res.status(403).json({ error: 'Verify your email and activate a plan first.' });
    }

    const sender = await prisma.verifiedSender.findFirst({
      where: {
        userId,
        email: body.from.trim().toLowerCase(),
        verificationStatus: 'VERIFIED',
      },
      select: { email: true },
    });
    if (!sender) {
      return res.status(403).json({
        error: 'The From address must be verified for this account.',
      });
    }

    const recipients = [...new Set([
      ...body.recipients.to,
      ...body.recipients.cc,
      ...body.recipients.bcc,
    ])];
    const subscription = user.subscriptions[0];
    const batchLimit = Math.floor(subscription.emailsPer24Hours / 10);
    if (recipients.length > batchLimit) {
      return res.status(400).json({
        error: `This plan allows at most ${batchLimit} recipients per send.`,
      });
    }
    const used = await prisma.quotaLedger.count({
      where: {
        userId,
        status: { in: ['RESERVED', 'SENT'] },
        reservedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    const remaining = Math.max(0, subscription.emailsPer24Hours - used);
    if (recipients.length > remaining) {
      return res.status(429).json({
        error: `Only ${remaining} emails remain in your rolling 24-hour quota.`,
      });
    }

    const blocked = await prisma.$queryRaw`
      SELECT recipient_email AS email
      FROM public.blocked_senders
      WHERE sender_user_id = ${userId}
        AND sender_email = ${sender.email}
        AND recipient_email IN (${Prisma.join(recipients)})
    `;
    if (blocked.length) {
      return res.status(403).json({
        error: 'One or more recipients blocked this sender and cannot be included.',
      });
    }

    return res.status(503).json({
      error: 'No message was sent. Outbound delivery remains disabled until relay routing, opt-out links, and quota reservations are fully configured.',
    });
  } catch (error) {
    console.error('Mailer request validation failed:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Message submission could not be completed.' });
  }
};
