const { createHmac, randomUUID, timingSafeEqual } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');
const { parseRequestBody } = require('../utils/request-body');
const { getPlanTier } = require('../utils/pricing');

const prisma = new PrismaClient();
const allowedDurations = new Set([1, 3, 6, 12]);
const MAX_FAILED_REDEMPTIONS_PER_HOUR = 10;

function hashCode(code) {
  const secret = process.env.ACTIVATION_CODE_SECRET || process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('ACTIVATION_CODE_SECRET or a 32-byte SESSION_SECRET is required.');
  }
  return createHmac('sha256', secret).update(String(code).trim().toUpperCase()).digest('hex');
}

function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
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
    console.error('Activation session configuration error:', error.message);
    return res.status(500).json({ error: 'Session is not configured.' });
  }
  if (!userId) return res.status(401).json({ error: 'Please log in.' });

  let body;
  try {
    body = parseRequestBody(req.body, String(req.headers && req.headers['content-type'] || ''));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid activation request.' });
  }
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!/^ACT-\d+K-[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a valid activation code.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, emailVerifiedAt: true, status: true },
    });
    if (!user || user.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account cannot be activated.' });
    }
    if (!user.emailVerifiedAt) {
      return res.status(403).json({ error: 'Verify your email before activating a plan.' });
    }
    const recentFailures = await prisma.$queryRaw`
      SELECT count(*)::int AS count
      FROM public."ComplianceEvent"
      WHERE "userId" = ${user.id}
        AND "eventType" = 'ACTIVATION_CODE_FAILED'
        AND "createdAt" >= now() - interval '1 hour'
    `;
    if (recentFailures[0].count >= MAX_FAILED_REDEMPTIONS_PER_HOUR) {
      return res.status(429).json({ error: 'Too many invalid activation attempts. Try again later.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const accounts = await tx.$queryRaw`
        SELECT status, "emailVerifiedAt"
        FROM public."User" WHERE id = ${user.id} FOR UPDATE
      `;
      if (!accounts.length || accounts[0].status === 'SUSPENDED' || !accounts[0].emailVerifiedAt) {
        return { activated: false };
      }
      const codeRows = await tx.$queryRaw`
        SELECT id, code_hash AS "codeHash", daily_limit AS "dailyLimit",
               duration_months AS "durationMonths", amount_usd AS "amountUsd", status,
               assigned_to_user_id AS "assignedToUserId", pending_order_id AS "pendingOrderId"
        FROM public.activation_codes WHERE code_hash = ${hashCode(code)} FOR UPDATE
      `;
      const activation = codeRows[0];
      if (!activation || !equalHash(activation.codeHash, hashCode(code)) ||
          activation.status !== 'UNUSED' ||
          (activation.assignedToUserId && activation.assignedToUserId !== user.id)) {
        return { activated: false };
      }

      const tier = getPlanTier(activation.dailyLimit);
      if (!tier || !allowedDurations.has(activation.durationMonths)) {
        throw new Error('Activation code has invalid plan data.');
      }
      if (activation.pendingOrderId) {
        const orderRows = await tx.$queryRaw`
          SELECT status FROM public.pending_orders WHERE id = ${activation.pendingOrderId} FOR UPDATE
        `;
        if (!orderRows.length || !['PAID', 'CODE_SENDING', 'CODE_SENT'].includes(orderRows[0].status)) {
          return { activated: false };
        }
      }

      const now = new Date();
      const currentRows = await tx.$queryRaw`
        SELECT "expiresAt" FROM public."Subscription"
        WHERE "userId" = ${user.id} AND status = 'ACTIVE' AND "paymentStatus" = 'PAID'
          AND "expiresAt" > ${now}
        ORDER BY "expiresAt" DESC LIMIT 1 FOR UPDATE
      `;
      const startsAt = currentRows.length ? currentRows[0].expiresAt : now;
      const expiresAt = addMonths(startsAt, activation.durationMonths);
      const amount = Number(activation.amountUsd);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error('Activation code has invalid pricing data.');
      }
      const subscriptions = await tx.$queryRaw`
        INSERT INTO public."Subscription" (
          id, "userId", status, "paymentStatus", currency, "emailsPer24Hours",
          "durationMonths", amount, provider, "paymentMethod", "countryCode",
          "startsAt", "expiresAt", "paidAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${randomUUID()}, ${user.id}, 'ACTIVE', 'PAID', 'USD', ${tier.dailyLimit},
          ${activation.durationMonths}, ${amount}, 'MANUAL', 'OFFLINE', NULL,
          ${startsAt}, ${expiresAt}, ${now}, ${now}, ${now}
        )
        RETURNING id, "emailsPer24Hours" AS "dailyLimit", "startsAt", "expiresAt"
      `;
      const updatedCodes = await tx.$executeRaw`
        UPDATE public.activation_codes
        SET status = 'ACTIVE', redeemed_by_user_id = ${user.id}, redeemed_at = ${now},
            starts_at = ${startsAt}, expires_at = ${expiresAt},
            subscription_id = ${subscriptions[0].id}
        WHERE id = ${activation.id} AND status = 'UNUSED'
      `;
      if (updatedCodes !== 1) throw new Error('Activation code was consumed concurrently.');
      await tx.$executeRaw`
        UPDATE public."User" SET status = 'ACTIVE', "activatedAt" = ${now}, "updatedAt" = ${now}
        WHERE id = ${user.id} AND status <> 'SUSPENDED'
      `;
      if (activation.pendingOrderId) {
        await tx.$executeRaw`
          UPDATE public.pending_orders SET status = 'FULFILLED', fulfilled_at = ${now}, updated_at = ${now}
          WHERE id = ${activation.pendingOrderId} AND status IN ('PAID', 'CODE_SENDING', 'CODE_SENT')
        `;
      }
      return { activated: true, subscription: subscriptions[0] };
    });

    if (!result.activated) {
      await prisma.$executeRaw`
        INSERT INTO public."ComplianceEvent" ("userId", "eventType", "createdAt")
        VALUES (${user.id}, 'ACTIVATION_CODE_FAILED', now())
      `;
      return res.status(400).json({ error: 'Invalid, unpaid, already used, or unassigned activation code.' });
    }
    return res.status(200).json({ message: 'Plan activated.', subscription: result.subscription });
  } catch (error) {
    console.error('Activation code redemption failed:', {
      code: error && error.code,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Activation could not be completed.' });
  }
};
