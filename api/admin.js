const { createHmac, randomBytes } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');
const { parseRequestBody } = require('../utils/request-body');
const { getPlanTier, PLAN_DURATIONS_MONTHS } = require('../utils/pricing');
const { sendEmail } = require('../utils/email');

const prisma = new PrismaClient();
const allowedMethods = new Set([
  'MOBILE_MONEY',
  'BANK_TRANSFER',
  'WESTERN_UNION',
  'MONEYGRAM',
  'INTERNATIONAL_WIRE',
  'IN_PERSON_CASH',
  'OTHER',
]);

function hashCode(code) {
  const secret = process.env.ACTIVATION_CODE_SECRET || process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('ACTIVATION_CODE_SECRET or a 32-byte SESSION_SECRET is required.');
  }
  return createHmac('sha256', secret).update(code).digest('hex');
}

async function requireAdmin(req, res) {
  let userId;
  try {
    userId = getSessionUserId(req);
  } catch (error) {
    console.error('Admin session configuration error:', error.message);
    res.status(500).json({ error: 'Session is not configured.' });
    return null;
  }
  if (!userId) {
    res.status(401).json({ error: 'Please log in.' });
    return null;
  }
  const rows = await prisma.$queryRaw`
    SELECT role FROM public.profiles WHERE user_id = ${userId}
  `;
  if (!rows.length || rows[0].role !== 'ADMIN') {
    res.status(403).json({ error: 'Administrator access is required.' });
    return null;
  }
  return userId;
}

function parseAdminBody(req) {
  return parseRequestBody(req.body, String(req.headers && req.headers['content-type'] || ''));
}

async function getOrders() {
  return prisma.$queryRaw`
    SELECT o.id, u.email, o.daily_limit AS "dailyLimit", o.amount_usd AS "amountUsd",
           o.duration_months AS "durationMonths", o.country_code AS "countryCode",
           o.customer_name AS "customerName", o.customer_email AS "customerEmail",
           o.phone_whatsapp AS "phoneWhatsapp", o.additional_notes AS "additionalNotes",
           o.city, o.payment_method AS "paymentMethod", o.status,
           o.requested_at AS "requestedAt", o.paid_at AS "paidAt",
           o.admin_notified_at AS "adminNotifiedAt"
    FROM public.pending_orders o
    JOIN public."User" u ON u.id = o.user_id
    ORDER BY CASE WHEN o.status = 'PENDING' THEN 0 ELSE 1 END, o.requested_at DESC
    LIMIT 500
  `;
}

async function getTemplates() {
  return prisma.$queryRaw`
    SELECT id, name, subject, body
    FROM public.payment_instruction_templates
    WHERE is_active = true
    ORDER BY name
  `;
}

async function saveTemplate(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const templateBody = typeof body.body === 'string' ? body.body.trim() : '';
  if (!name || name.length > 100 || !subject || subject.length > 200 ||
      /[\r\n]/.test(subject) || !templateBody || templateBody.length > 8000) {
    throw new TypeError('Enter a template name, subject, and message.');
  }
  const rows = await prisma.$queryRaw`
    INSERT INTO public.payment_instruction_templates (name, subject, body)
    VALUES (${name}, ${subject}, ${templateBody})
    ON CONFLICT (name) DO UPDATE
      SET subject = EXCLUDED.subject, body = EXCLUDED.body,
          is_active = true, updated_at = now()
    RETURNING id, name, subject, body
  `;
  return { template: rows[0] };
}

async function sendPaymentInstructions(orderId, subject, instructions) {
  if (typeof orderId !== 'string' || !orderId) throw new TypeError('Order ID is required.');
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 ||
      /[\r\n]/.test(subject)) {
    throw new TypeError('Enter a valid email subject.');
  }
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 8000) {
    throw new TypeError('Enter payment instructions (maximum 8,000 characters).');
  }
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error('Configure RESEND_API_KEY and EMAIL_FROM before sending instructions.');
  }
  const orders = await prisma.$queryRaw`
    SELECT customer_email AS email, customer_name AS name, status
    FROM public.pending_orders WHERE id = ${orderId}
  `;
  if (!orders.length) throw new Error('Pending order was not found.');
  if (!['PENDING', 'PAID'].includes(orders[0].status)) {
    throw new Error('Payment instructions can only be sent for an open order.');
  }
  await sendEmail({
    to: orders[0].email,
    subject: subject.trim(),
    text: `Hello ${orders[0].name},\n\n${instructions.trim()}\n\nFor questions, use the Contact Us form on our website.`,
  });
  return { sent: true, email: orders[0].email };
}

async function getAgents() {
  return prisma.$queryRaw`
    SELECT id, country_code AS "countryCode", region, city, is_fallback AS "isFallback",
           payment_method AS "paymentMethod", recipient_name AS "recipientName",
           account_reference AS "accountReference", contact_phone AS "contactPhone",
           whatsapp, instructions, is_active AS "isActive", priority
    FROM public.payment_agents ORDER BY is_fallback, country_code, priority
  `;
}

async function getUsers() {
  return prisma.$queryRaw`
    SELECT u.id, u.email, u.status,
           s."emailsPer24Hours" AS "dailyLimit", s."expiresAt" AS "expiresAt",
           COALESCE(q.used, 0)::integer AS "usedLast24Hours"
    FROM public."User" u
    LEFT JOIN LATERAL (
      SELECT "emailsPer24Hours", "expiresAt"
      FROM public."Subscription"
      WHERE "userId" = u.id AND status = 'ACTIVE' AND "paymentStatus" = 'PAID'
        AND "expiresAt" > now()
      ORDER BY "expiresAt" DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS used FROM public."QuotaLedger"
      WHERE "userId" = u.id AND status IN ('RESERVED', 'SENT')
        AND "reservedAt" >= now() - interval '24 hours'
    ) q ON true
    ORDER BY u."registeredAt" DESC LIMIT 500
  `;
}

async function getCodes() {
  return prisma.$queryRaw`
    SELECT c.id, c.code_prefix AS "codePrefix", c.daily_limit AS "dailyLimit",
           c.duration_months AS "durationMonths",
           CASE WHEN c.status = 'ACTIVE' AND c.expires_at <= now()
                THEN 'EXPIRED' ELSE c.status END AS status,
           assigned.email AS "assignedEmail", redeemed.email AS "redeemedByEmail",
           c.created_at AS "createdAt", c.redeemed_at AS "redeemedAt",
           c.expires_at AS "expiresAt"
    FROM public.activation_codes c
    LEFT JOIN public."User" assigned ON assigned.id = c.assigned_to_user_id
    LEFT JOIN public."User" redeemed ON redeemed.id = c.redeemed_by_user_id
    ORDER BY c.created_at DESC LIMIT 500
  `;
}

async function markOrderPaid(orderId) {
  if (typeof orderId !== 'string' || !orderId) throw new TypeError('Order ID is required.');
  const changed = await prisma.$executeRaw`
    UPDATE public.pending_orders
    SET status = 'PAID', paid_at = now(), updated_at = now()
    WHERE id = ${orderId} AND status = 'PENDING'
  `;
  if (changed !== 1) throw new Error('Pending order was not found or is no longer pending.');
  return { status: 'PAID' };
}

async function createAgent(body) {
  const countryCode = typeof body.countryCode === 'string'
    ? body.countryCode.trim().toUpperCase()
    : '';
  const isFallback = body.isFallback === true || body.isFallback === 'true';
  const paymentMethod = typeof body.paymentMethod === 'string'
    ? body.paymentMethod.trim().toUpperCase()
    : '';
  if (!allowedMethods.has(paymentMethod)) throw new TypeError('Choose a valid payment method.');
  if (isFallback ? countryCode !== '' : !/^[A-Z]{2}$/.test(countryCode)) {
    throw new TypeError('Fallback instructions must have no country; local instructions need a two-letter country.');
  }
  if (typeof body.instructions !== 'string' || !body.instructions.trim()) {
    throw new TypeError('Payment instructions are required.');
  }
  const values = {
    region: typeof body.region === 'string' ? body.region.trim() || null : null,
    city: typeof body.city === 'string' ? body.city.trim() || null : null,
    recipientName: typeof body.recipientName === 'string' ? body.recipientName.trim() || null : null,
    accountReference: typeof body.accountReference === 'string' ? body.accountReference.trim() || null : null,
    contactPhone: typeof body.contactPhone === 'string' ? body.contactPhone.trim() || null : null,
    whatsapp: typeof body.whatsapp === 'string' ? body.whatsapp.trim() || null : null,
    instructions: body.instructions.trim(),
    priority: Number.isSafeInteger(Number(body.priority)) ? Number(body.priority) : 100,
    isActive: body.isActive !== false && body.isActive !== 'false',
  };
  if (typeof body.id === 'string' && body.id) {
    const changed = await prisma.$executeRaw`
      UPDATE public.payment_agents SET
        country_code = ${isFallback ? null : countryCode}, region = ${values.region},
        city = ${values.city}, is_fallback = ${isFallback},
        payment_method = ${paymentMethod}, recipient_name = ${values.recipientName},
        account_reference = ${values.accountReference}, contact_phone = ${values.contactPhone},
        whatsapp = ${values.whatsapp}, instructions = ${values.instructions},
        is_active = ${values.isActive}, priority = ${values.priority}, updated_at = now()
      WHERE id = ${body.id}
    `;
    if (changed !== 1) throw new Error('Payment agent was not found.');
    return { id: body.id };
  }
  const rows = await prisma.$queryRaw`
    INSERT INTO public.payment_agents (
      country_code, region, city, is_fallback, payment_method, recipient_name,
      account_reference, contact_phone, whatsapp, instructions, priority, is_active
    ) VALUES (
      ${isFallback ? null : countryCode}, ${values.region}, ${values.city}, ${isFallback},
      ${paymentMethod}, ${values.recipientName}, ${values.accountReference},
      ${values.contactPhone}, ${values.whatsapp}, ${values.instructions},
      ${values.priority}, ${values.isActive}
    ) RETURNING id
  `;
  return { id: rows[0].id };
}

async function deleteAgent(id) {
  if (typeof id !== 'string' || !id) throw new TypeError('Agent ID is required.');
  const changed = await prisma.$executeRaw`
    DELETE FROM public.payment_agents WHERE id = ${id}
  `;
  if (changed !== 1) throw new Error('Payment agent was not found.');
  return { deleted: true };
}

async function generateCode(body) {
  const orderId = typeof body.orderId === 'string' && body.orderId ? body.orderId : null;
  const requestedTier = getPlanTier(body.dailyLimit);
  const requestedMonths = Number(body.durationMonths);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new TypeError('Enter a valid account email.');
  }
  if (!orderId && (!requestedTier || !PLAN_DURATIONS_MONTHS.includes(requestedMonths))) {
    throw new TypeError('Choose a valid tier and duration.');
  }

  return prisma.$transaction(async (tx) => {
    let dailyLimit = requestedTier && requestedTier.dailyLimit;
    let durationMonths = requestedMonths;
    let assignedUserId = null;
    if (email) {
      const users = await tx.$queryRaw`
        SELECT id FROM public."User" WHERE lower(email) = ${email} LIMIT 1
      `;
      if (!users.length) throw new Error('No account exists for the assigned email.');
      assignedUserId = users[0].id;
    }
    if (orderId) {
      const orders = await tx.$queryRaw`
        SELECT user_id AS "userId", daily_limit AS "dailyLimit",
               duration_months AS "durationMonths", amount_usd AS "amountUsd", status
        FROM public.pending_orders WHERE id = ${orderId} FOR UPDATE
      `;
      if (!orders.length || orders[0].status !== 'PAID') {
        throw new Error('Only a confirmed paid order can receive an activation code.');
      }
      const order = orders[0];
      if ((dailyLimit && dailyLimit !== order.dailyLimit) ||
          (requestedMonths && requestedMonths !== order.durationMonths) ||
          (assignedUserId && assignedUserId !== order.userId)) {
        throw new Error('Code details must match the selected order.');
      }
      dailyLimit = order.dailyLimit;
      durationMonths = order.durationMonths;
      assignedUserId = order.userId;
      body.amountUsd = order.amountUsd;
    }

    const tier = getPlanTier(dailyLimit);
    if (!tier || !PLAN_DURATIONS_MONTHS.includes(durationMonths)) {
      throw new TypeError('Choose a valid tier and duration.');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const visibleCode = `ACT-${Math.round(tier.dailyLimit / 1000)}K-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
      const codeHash = hashCode(visibleCode);
      const amountUsd = body.amountUsd === undefined
        ? tier.monthlyPriceUsd * durationMonths
        : Number(body.amountUsd);
      if (!Number.isFinite(amountUsd) || amountUsd < 0) {
        throw new Error('Order price is invalid.');
      }
      try {
        const rows = await tx.$queryRaw`
          INSERT INTO public.activation_codes (
            code_hash, code_prefix, daily_limit, duration_months, amount_usd,
            assigned_to_user_id, pending_order_id
          ) VALUES (
            ${codeHash}, ${`ACT-${Math.round(tier.dailyLimit / 1000)}K`},
            ${tier.dailyLimit}, ${durationMonths}, ${amountUsd}, ${assignedUserId}, ${orderId}
          )
          ON CONFLICT (code_hash) DO NOTHING
          RETURNING id
        `;
        if (!rows.length) continue;
        return {
          code: visibleCode,
          codeId: rows[0].id,
          dailyLimit: tier.dailyLimit,
          batchLimit: tier.batchLimit,
          durationMonths,
          amountUsd,
          assignedEmail: email || null,
        };
      } catch (error) { throw error; }
    }
    throw new Error('Could not generate a unique activation code.');
  });
}

module.exports = async function handler(req, res) {
  let body = {};
  if (req.method === 'POST') {
    try {
      body = parseAdminBody(req);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid admin request body.' });
    }
  } else if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    if (!await requireAdmin(req, res)) return;
    if (req.method === 'GET') {
      const view = String(req.query && req.query.view || 'orders');
      const handlers = {
        orders: getOrders,
        agents: getAgents,
        users: getUsers,
        codes: getCodes,
        templates: getTemplates,
      };
      if (!handlers[view]) return res.status(400).json({ error: 'Unknown admin view.' });
      return res.status(200).json({ [view]: await handlers[view]() });
    }

    let result;
    if (body.action === 'markPaid') result = await markOrderPaid(body.orderId);
    else if (body.action === 'saveAgent') result = await createAgent(body);
    else if (body.action === 'deleteAgent') result = await deleteAgent(body.id);
    else if (body.action === 'generateCode') result = await generateCode(body);
    else if (body.action === 'saveTemplate') result = await saveTemplate(body);
    else if (body.action === 'sendPaymentInstructions') {
      result = await sendPaymentInstructions(body.orderId, body.subject, body.instructions);
    }
    else return res.status(400).json({ error: 'Unknown admin action.' });
    return res.status(200).json(result);
  } catch (error) {
    const clientError = error instanceof TypeError ||
      /not found|Only a confirmed|must match|No account exists|Could not generate/i.test(error.message || '');
    if (!clientError) {
      console.error('Admin operation failed:', {
        code: error && error.code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return res.status(clientError ? 400 : 500).json({
      error: clientError ? error.message : 'Admin operation could not be completed.',
    });
  }
};
