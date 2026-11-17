const { PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');
const { parseRequestBody } = require('../utils/request-body');
const { getPlanTier, PLAN_DURATIONS_MONTHS } = require('../utils/pricing');
const { sendEmail } = require('../utils/email');

const prisma = new PrismaClient();
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const countryPattern = /^[A-Z]{2}$/;
const allowedMethods = new Set([
  'MOBILE_MONEY',
  'BANK_TRANSFER',
  'WESTERN_UNION',
  'MONEYGRAM',
  'INTERNATIONAL_WIRE',
  'IN_PERSON_CASH',
  'OTHER',
]);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let userId;
  try {
    userId = getSessionUserId(req);
  } catch (error) {
    console.error('Order session configuration error:', error.message);
    return res.status(500).json({ error: 'Session is not configured.' });
  }
  if (!userId) return res.status(401).json({ error: 'Please log in.' });

  let body;
  try {
    body = parseRequestBody(req.body, String(req.headers && req.headers['content-type'] || ''));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid order request body.' });
  }

  const tier = getPlanTier(body.dailyLimit);
  const durationMonths = Number(body.durationMonths);
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const countryCode = typeof body.countryCode === 'string'
    ? body.countryCode.trim().toUpperCase()
    : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const paymentMethod = typeof body.paymentMethod === 'string'
    ? body.paymentMethod.trim().toUpperCase()
    : '';
  const additionalNotes = typeof body.additionalNotes === 'string'
    ? body.additionalNotes.trim()
    : '';

  if (!tier || !PLAN_DURATIONS_MONTHS.includes(durationMonths)) {
    return res.status(400).json({ error: 'Choose a valid plan tier and duration.' });
  }
  if (
    fullName.length < 2 || fullName.length > 160 ||
    !emailPattern.test(email) || email.length > 254 ||
    phone.length < 5 || phone.length > 40 ||
    !countryPattern.test(countryCode) ||
    !city || city.length > 120 ||
    !allowedMethods.has(paymentMethod) ||
    additionalNotes.length > 2000
  ) {
    return res.status(400).json({ error: 'Check the required customer and payment request details.' });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || !emailPattern.test(adminEmail) ||
      !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return res.status(503).json({
      error: 'Billing notifications are not configured. Please try again later.',
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true, status: true },
    });
    if (!user || user.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account cannot request a plan.' });
    }
    if (!user.emailVerifiedAt) {
      return res.status(403).json({ error: 'Verify your email before requesting a plan.' });
    }
    if (email !== user.email.toLowerCase()) {
      return res.status(400).json({ error: 'Use the verified email address on your account.' });
    }

    const amountUsd = tier.monthlyPriceUsd * durationMonths;
    const orders = await prisma.$queryRaw`
      INSERT INTO public.pending_orders (
        user_id, daily_limit, duration_months, amount_usd,
        customer_name, customer_email, phone_whatsapp, additional_notes,
        country_code, city, payment_method, payment_instructions_snapshot
      )
      VALUES (
        ${user.id}, ${tier.dailyLimit}, ${durationMonths}, ${amountUsd},
        ${fullName}, ${user.email}, ${phone}, ${additionalNotes || null},
        ${countryCode}, ${city}, ${paymentMethod}, NULL
      )
      RETURNING id, daily_limit AS "dailyLimit", duration_months AS "durationMonths",
                amount_usd AS "amountUsd", country_code AS "countryCode", city,
                payment_method AS "paymentMethod", status, requested_at AS "requestedAt"
    `;
    const order = orders[0];
    const details = [
      `Order ID: ${order.id}`,
      `Name: ${fullName}`,
      `Email: ${user.email}`,
      `Phone / WhatsApp: ${phone}`,
      `Location: ${city}, ${countryCode}`,
      `Plan: ${tier.dailyLimit} emails/day (${tier.batchLimit} per send)`,
      `Duration: ${durationMonths} month(s)`,
      `Total: USD ${amountUsd.toFixed(2)}`,
      `Preferred payment method: ${paymentMethod}`,
      `Additional notes: ${additionalNotes || '(none)'}`,
    ].join('\n');

    try {
      await sendEmail({
        to: adminEmail,
        subject: `New payment request from ${fullName}`,
        text: details,
      });
      await prisma.$executeRaw`
        UPDATE public.pending_orders SET admin_notified_at = now() WHERE id = ${order.id}
      `;
    } catch (error) {
      console.error('Payment request admin notification failed:', {
        orderId: order.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json({
        error: 'Your request was saved, but the billing alert could not be sent. Please try again later.',
        orderSaved: true,
        orderId: order.id,
      });
    }

    return res.status(201).json({
      orderId: order.id,
      message: 'Your request has been received. Our billing team will email your customized payment instructions shortly.',
    });
  } catch (error) {
    console.error('Order request failed:', {
      code: error && error.code,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Your order request could not be saved.' });
  }
};
