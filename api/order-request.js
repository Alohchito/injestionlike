const { PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');
const { parseRequestBody } = require('../utils/request-body');
const { getPlanPricing, PLAN_DURATIONS_MONTHS } = require('../utils/pricing');
const { sendEmail } = require('../utils/email');

const prisma = new PrismaClient();
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const countryPattern = /^[A-Z]{2}$/;
const RECEIPT_CHUNK_BYTES = 1024 * 1024;
const RECEIPT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
function parseBody(req) {
  return parseRequestBody(req.body, String(req.headers && req.headers['content-type'] || ''));
}

function validEmailConfiguration() {
  const adminEmail = process.env.ADMIN_EMAIL;
  return adminEmail && emailPattern.test(adminEmail) &&
    process.env.RESEND_API_KEY && process.env.EMAIL_FROM;
}

function receiptMatchesType(data, contentType) {
  if (contentType === 'application/pdf') return data.subarray(0, 5).toString('ascii') === '%PDF-';
  if (contentType === 'image/png') {
    return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === 'image/jpeg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (contentType === 'image/webp') {
    return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

async function submitReceiptChunk(res, userId, body) {
  const orderId = typeof body.orderId === 'string' ? body.orderId : '';
  const chunkIndex = Number(body.chunkIndex);
  const encoded = typeof body.data === 'string' ? body.data : '';
  if (!orderId || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
      encoded.length > Math.ceil(RECEIPT_CHUNK_BYTES * 4 / 3) + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return res.status(400).json({ error: 'Invalid receipt upload chunk.' });
  }
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > RECEIPT_CHUNK_BYTES || data.toString('base64') !== encoded) {
    return res.status(400).json({ error: 'Receipt upload chunk has an invalid size or encoding.' });
  }

  const orders = await prisma.$queryRaw`
    SELECT id, customer_name AS "customerName", customer_email AS "customerEmail",
           country_name AS "countryName", country_code AS "countryCode", city,
           daily_limit AS "dailyLimit", duration_months AS "durationMonths",
           amount_usd AS "amountUsd", receipt_size AS "receiptSize",
           receipt_chunk_count AS "receiptChunkCount", receipt_file_name AS "receiptFileName",
           receipt_content_type AS "receiptContentType",
           status
    FROM public.pending_orders
    WHERE id = ${orderId} AND user_id = ${userId}
  `;
  const order = orders[0];
  if (!order || !order.receiptSize ||
      !['RECEIPT_UPLOADING', 'RECEIPT_SUBMITTED'].includes(order.status) ||
      chunkIndex >= order.receiptChunkCount) {
    return res.status(404).json({ error: 'Receipt upload was not found or is no longer available.' });
  }
  const expectedSize = chunkIndex < order.receiptChunkCount - 1
    ? RECEIPT_CHUNK_BYTES
    : order.receiptSize - RECEIPT_CHUNK_BYTES * (order.receiptChunkCount - 1);
  if (data.length !== expectedSize) {
    return res.status(400).json({ error: 'Receipt upload chunk size does not match the requested file.' });
  }

  await prisma.$executeRaw`
    INSERT INTO public.pending_order_receipt_chunks (order_id, chunk_index, data)
    VALUES (${orderId}, ${chunkIndex}, ${data})
    ON CONFLICT (order_id, chunk_index) DO UPDATE SET data = EXCLUDED.data
  `;
  const totals = await prisma.$queryRaw`
    SELECT count(*)::int AS chunks, COALESCE(sum(octet_length(data)), 0)::int AS bytes
    FROM public.pending_order_receipt_chunks WHERE order_id = ${orderId}
  `;
  if (totals[0].chunks !== order.receiptChunkCount) {
    return res.status(200).json({ received: true, complete: false });
  }
  if (totals[0].bytes !== order.receiptSize) {
    return res.status(400).json({ error: 'Uploaded receipt size does not match the selected file.' });
  }
  const receiptChunks = await prisma.$queryRaw`
    SELECT data FROM public.pending_order_receipt_chunks
    WHERE order_id = ${orderId} ORDER BY chunk_index
  `;
  const receiptData = Buffer.concat(receiptChunks.map((row) => Buffer.from(row.data)));
  if (!receiptMatchesType(receiptData, order.receiptContentType)) {
    await prisma.$executeRaw`
      DELETE FROM public.pending_order_receipt_chunks WHERE order_id = ${orderId}
    `;
    await prisma.$executeRaw`
      UPDATE public.pending_orders
      SET status = 'PENDING_INSTRUCTIONS', receipt_file_name = NULL,
          receipt_content_type = NULL, receipt_size = NULL,
          receipt_chunk_count = 0, updated_at = now()
      WHERE id = ${orderId} AND status = 'RECEIPT_UPLOADING'
    `;
    return res.status(400).json({ error: 'The uploaded file does not match its declared receipt type. Please choose a valid image or PDF.' });
  }

  await prisma.$executeRaw`
    UPDATE public.pending_orders
    SET status = 'RECEIPT_SUBMITTED', updated_at = now()
    WHERE id = ${orderId} AND status = 'RECEIPT_UPLOADING'
  `;
  const notificationRows = await prisma.$queryRaw`
    SELECT receipt_notified_at AS "receiptNotifiedAt"
    FROM public.pending_orders WHERE id = ${orderId}
  `;
  if (!notificationRows[0].receiptNotifiedAt) {
    const receiptUrl = `${process.env.PUBLIC_SITE_URL || 'https://injestionlike-2eer.vercel.app'}/admin?order=${encodeURIComponent(orderId)}`;
    try {
      await sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: `Payment receipt submitted by ${order.customerName}`,
        text: [
          `Order ID: ${order.id}`,
          `Customer: ${order.customerName} <${order.customerEmail}>`,
          `Location: ${order.city || 'Not specified'}, ${order.countryName} (${order.countryCode})`,
          `Plan: ${Number(order.dailyLimit).toLocaleString()} emails/day for ${order.durationMonths} month(s)`,
          `Total due: USD ${Number(order.amountUsd).toFixed(2)}`,
          `Receipt: ${order.receiptFileName}`,
          `View the receipt in the protected administrator dashboard: ${receiptUrl}`,
        ].join('\n'),
      });
      await prisma.$executeRaw`
        UPDATE public.pending_orders SET receipt_notified_at = now() WHERE id = ${orderId}
      `;
    } catch (error) {
      console.error('Receipt notification failed:', {
        orderId,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json({
        error: 'Your receipt was saved, but the billing alert could not be sent. Please retry the upload.',
        receiptSaved: true,
      });
    }
  }
  return res.status(200).json({ received: true, complete: true });
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
    console.error('Order session configuration error:', error.message);
    return res.status(500).json({ error: 'Session is not configured.' });
  }
  if (!userId) return res.status(401).json({ error: 'Please log in.' });

  let body;
  try {
    body = parseBody(req);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid order request body.' });
  }
  if (body.action === 'receiptChunk') {
    try {
      return await submitReceiptChunk(res, userId, body);
    } catch (error) {
      console.error('Receipt chunk upload failed:', {
        code: error && error.code,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ error: 'Receipt upload could not be completed.' });
    }
  }

  const tier = getPlanPricing(body.dailyLimit, body.durationMonths);
  const durationMonths = Number(body.durationMonths);
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const countryCode = typeof body.countryCode === 'string'
    ? body.countryCode.trim().toUpperCase()
    : '';
  const countryName = typeof body.countryName === 'string' ? body.countryName.trim() : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const paymentText = `Subject: ${subject}\n${message}`.trim();
  const rawReceiptName = typeof body.receiptFileName === 'string' ? body.receiptFileName.trim() : '';
  const receiptFileName = rawReceiptName.replace(/[\\/\r\n]/g, '_').slice(0, 180);
  const receiptContentType = typeof body.receiptContentType === 'string'
    ? body.receiptContentType.toLowerCase()
    : '';
  const receiptSize = body.receiptSize === undefined || body.receiptSize === null
    ? null
    : Number(body.receiptSize);
  const receiptChunkCount = body.receiptChunkCount === undefined || body.receiptChunkCount === null
    ? 0
    : Number(body.receiptChunkCount);

  if (!tier || !PLAN_DURATIONS_MONTHS.includes(durationMonths)) {
    return res.status(400).json({ error: 'Choose a valid plan tier and subscription duration.' });
  }
  if (
    fullName.length < 2 || fullName.length > 160 ||
    !emailPattern.test(email) || email.length > 254 ||
    !countryPattern.test(countryCode) || !countryName || countryName.length > 100 ||
    city.length > 120 || !subject || subject.length > 200 || /[\r\n]/.test(subject) ||
    message.length < 5 || message.length > 2000 || paymentText.length > 2200 ||
    ((receiptSize !== null) && (
      !Number.isSafeInteger(receiptSize) || receiptSize < 1 || receiptSize > 5 * 1024 * 1024 ||
      !RECEIPT_TYPES.has(receiptContentType) ||
      !receiptFileName ||
      receiptChunkCount !== Math.ceil(receiptSize / RECEIPT_CHUNK_BYTES)
    ))
  ) {
    return res.status(400).json({ error: 'Check the required contact, plan, and receipt details.' });
  }
  if (!validEmailConfiguration()) {
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

    const amountUsd = tier.totalCents / 100;
    const baseAmountUsd = tier.basePriceCents / 100;
    const discountAmountUsd = tier.discountCents / 100;
    const status = receiptSize ? 'RECEIPT_UPLOADING' : 'PENDING_INSTRUCTIONS';
    const orders = await prisma.$queryRaw`
      INSERT INTO public.pending_orders (
        user_id, daily_limit, duration_months, amount_usd, base_amount_usd,
        discount_percent, discount_amount_usd,
        customer_name, customer_email, phone_whatsapp, additional_notes,
        country_code, country_name, city, payment_method, payment_instructions_snapshot,
        status, receipt_file_name, receipt_content_type, receipt_size, receipt_chunk_count
      )
      VALUES (
        ${user.id}, ${tier.plan.dailyLimit}, ${durationMonths}, ${amountUsd}, ${baseAmountUsd},
        ${tier.discountPercent}, ${discountAmountUsd},
        ${fullName}, ${user.email}, '', ${paymentText || null},
        ${countryCode}, ${countryName}, ${city || null}, 'OTHER', NULL,
        ${status}, ${receiptSize ? receiptFileName : null},
        ${receiptSize ? receiptContentType : null}, ${receiptSize}, ${receiptChunkCount}
      )
      RETURNING id, daily_limit AS "dailyLimit", duration_months AS "durationMonths",
                amount_usd AS "amountUsd", base_amount_usd AS "baseAmountUsd",
                discount_percent AS "discountPercent",
                discount_amount_usd AS "discountAmountUsd",
                country_code AS "countryCode", country_name AS "countryName", city,
                status, requested_at AS "requestedAt"
    `;
    const order = orders[0];
    const receiptUrl = `${process.env.PUBLIC_SITE_URL || 'https://injestionlike-2eer.vercel.app'}/admin?order=${encodeURIComponent(order.id)}`;
    const details = [
      `Order ID: ${order.id}`,
      `Name: ${fullName}`,
      `Registered account email: ${user.email}`,
      `Location: ${city || 'Not specified'}, ${countryName} (${countryCode})`,
      `Plan: Tier ${tier.plan.tier}, ${tier.plan.dailyLimit} emails/day (${tier.plan.batchLimit} per send)`,
      `Duration: ${durationMonths} month(s)`,
      `Base price: USD ${baseAmountUsd.toFixed(2)}`,
      `Discount: ${tier.discountPercent}% (USD ${discountAmountUsd.toFixed(2)} saved)`,
      `Final total due: USD ${amountUsd.toFixed(2)}`,
      `Payment method / message: ${paymentText || '(not specified)'}`,
      `Receipt: ${receiptSize ? `${receiptFileName} (${receiptSize} bytes); upload status: RECEIPT_UPLOADING` : 'Not attached; payment instructions requested'}`,
      receiptSize ? `View receipt in the protected admin dashboard after upload completes: ${receiptUrl}` : '',
    ].filter(Boolean).join('\n');

    try {
      await sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: receiptSize
          ? `Payment request and receipt upload from ${fullName}`
          : `Payment instruction request from ${fullName}`,
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
        error: 'Your request was saved, but the billing alert could not be sent. Please contact us again.',
        orderSaved: true,
        orderId: order.id,
      });
    }

    return res.status(201).json({
      orderId: order.id,
      receiptChunkBytes: RECEIPT_CHUNK_BYTES,
      hasReceipt: Boolean(receiptSize),
      message: receiptSize
        ? 'Your request was received. Uploading your receipt securely now.'
        : 'Your request has been received. Our billing team will email your customized payment instructions shortly.',
    });
  } catch (error) {
    console.error('Order request failed:', {
      code: error && error.code,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Your order request could not be saved.' });
  }
};
