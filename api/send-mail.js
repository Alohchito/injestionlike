const { randomUUID } = require('crypto');
const { Prisma, PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');
const { parseRequestBody } = require('../utils/request-body');
const { createOptOutToken } = require('../utils/opt-out');
const { sendEmail } = require('../utils/email');

const prisma = new PrismaClient();
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELIVERY_CONCURRENCY = 5;

function parseAddressList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const addresses = value.split(',').map((address) => address.trim().toLowerCase());
  if (addresses.length > 1000 || addresses.some((address) => !emailPattern.test(address))) {
    throw new TypeError('Recipient addresses are invalid.');
  }
  return addresses;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function getPublicSiteUrl() {
  const configuredUrl = process.env.PUBLIC_SITE_URL || 'https://injestionlike.vercel.app';
  const url = new URL(configuredUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('PUBLIC_SITE_URL must be an HTTP(S) URL.');
  }
  return url.origin;
}

function getRelayFrom(displayName) {
  const safeName = String(displayName || 'Verified sender')
    .replace(/[\r\n"]/g, '')
    .trim()
    .slice(0, 100);
  if (!safeName) throw new Error('Verified sender display name is invalid.');
  const emailFrom = (process.env.EMAIL_FROM || '').trim();
  if (!emailPattern.test(emailFrom) || /[\r\n]/.test(emailFrom)) {
    throw new Error('EMAIL_FROM is not configured correctly.');
  }
  return `"${safeName} via Injestionlike" <${emailFrom}>`;
}

function formatEmailHtml(body, unsubscribeUrl) {
  const message = escapeHtml(body).replace(/\r\n|\r|\n/g, '<br>');
  return `<div>${message}</div><hr><p style="font-size:12px;color:#555">You are receiving this message from a sender using Injestionlike. <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe from this sender</a>.</p>`;
}

async function reserveRecipients({ userId, senderAddress, requestedRecipients }) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const accounts = await tx.$queryRaw`
      SELECT email, status, "emailVerifiedAt"
      FROM public."User"
      WHERE id = ${userId}
      FOR UPDATE
    `;
    if (!accounts.length || accounts[0].status === 'SUSPENDED') {
      return { status: 403, error: 'This account cannot send messages.' };
    }
    if (!accounts[0].emailVerifiedAt) {
      return { status: 403, error: 'Verify your email before sending.' };
    }

    const subscriptions = await tx.$queryRaw`
      SELECT id, "emailsPer24Hours" AS "dailyLimit", "expiresAt"
      FROM public."Subscription"
      WHERE "userId" = ${userId}
        AND status = 'ACTIVE'
        AND "paymentStatus" = 'PAID'
        AND "expiresAt" > ${now}
      ORDER BY "expiresAt" DESC
      LIMIT 1
      FOR UPDATE
    `;
    if (!subscriptions.length) {
      return { status: 403, error: 'An active, unexpired plan is required to send.' };
    }
    const subscription = subscriptions[0];
    const batchLimit = Math.floor(subscription.dailyLimit / 10);
    if (requestedRecipients.length > batchLimit) {
      return {
        status: 400,
        error: `This plan allows at most ${batchLimit} recipients per send.`,
      };
    }

    const senders = await tx.$queryRaw`
      SELECT id, email, "displayName", "verificationStatus"
      FROM public."VerifiedSender"
      WHERE "userId" = ${userId}
        AND lower(email) = ${senderAddress}
      FOR UPDATE
    `;
    let sender = senders.find((item) => item.verificationStatus === 'VERIFIED');
    const accountEmail = accounts[0].email.trim().toLowerCase();
    if (!sender && senderAddress === accountEmail) {
      const nowForSender = new Date();
      const displayName = accountEmail.split('@')[0] || 'Account sender';
      if (senders.length) {
        const updatedSenders = await tx.$queryRaw`
          UPDATE public."VerifiedSender"
          SET "displayName" = ${displayName},
              "verificationStatus" = 'VERIFIED',
              "verificationMethod" = 'EMAIL_LINK',
              "verifiedAt" = COALESCE("verifiedAt", ${nowForSender}),
              "updatedAt" = ${nowForSender}
          WHERE id = ${senders[0].id}
          RETURNING id, email, "displayName"
        `;
        sender = updatedSenders[0];
      } else {
        const createdSenders = await tx.$queryRaw`
          INSERT INTO public."VerifiedSender" AS current_sender (
            id, "userId", email, "displayName", "verificationStatus",
            "verificationMethod", "verifiedAt", "createdAt", "updatedAt"
          ) VALUES (
            ${randomUUID()}, ${userId}, ${accountEmail}, ${displayName}, 'VERIFIED',
            'EMAIL_LINK', ${nowForSender}, ${nowForSender}, ${nowForSender}
          )
          ON CONFLICT ("userId", email) DO UPDATE
          SET "displayName" = EXCLUDED."displayName",
              "verificationStatus" = 'VERIFIED',
              "verificationMethod" = 'EMAIL_LINK',
              "verifiedAt" = COALESCE(current_sender."verifiedAt", EXCLUDED."verifiedAt"),
              "updatedAt" = EXCLUDED."updatedAt"
          RETURNING id, email, "displayName"
        `;
        sender = createdSenders[0];
      }
    }
    if (!sender) {
      return { status: 403, error: 'The From address must be verified for this account.' };
    }

    const blockedRows = await tx.$queryRaw`
      SELECT lower(recipient_email) AS email
      FROM public.blocked_senders
      WHERE sender_user_id = ${userId}
        AND lower(sender_email) = ${senderAddress}
        AND lower(recipient_email) IN (${Prisma.join(requestedRecipients)})
    `;
    const suppressionRows = await tx.$queryRaw`
      SELECT lower(email) AS email
      FROM public."SuppressionEntry"
      WHERE lower(email) IN (${Prisma.join(requestedRecipients)})
    `;
    const excluded = new Set([
      ...blockedRows.map((row) => row.email),
      ...suppressionRows.map((row) => row.email),
    ]);
    const recipients = requestedRecipients.filter((email) => !excluded.has(email));
    if (!recipients.length) {
      return {
        status: 200,
        sender,
        reserved: [],
        skipped: requestedRecipients.length,
      };
    }

    const usedRows = await tx.$queryRaw`
      SELECT count(*)::int AS used
      FROM public."QuotaLedger"
      WHERE "userId" = ${userId}
        AND status IN ('RESERVED', 'SENT')
        AND "reservedAt" >= ${new Date(now.getTime() - ROLLING_WINDOW_MS)}
    `;
    const remaining = Math.max(0, subscription.dailyLimit - usedRows[0].used);
    if (recipients.length > remaining) {
      return {
        status: 429,
        error: `Only ${remaining} emails remain in your rolling 24-hour quota.`,
      };
    }

    const campaignId = randomUUID();
    const groupId = randomUUID();
    const campaignName = `Relay send ${now.toISOString()}`;
    await tx.$executeRaw`
      INSERT INTO public."RecipientGroup" (id, "userId", name, "createdAt", "updatedAt")
      VALUES (${groupId}, ${userId}, ${`relay-${randomUUID()}`}, ${now}, ${now})
    `;
    await tx.$executeRaw`
      INSERT INTO public."Campaign" (
        id, "userId", "senderId", name, "routingLocalPart", "isEnabled", "createdAt", "updatedAt"
      ) VALUES (
        ${campaignId}, ${userId}, ${sender.id}, ${campaignName},
        ${`relay-${randomUUID().replace(/-/g, '')}`}, false, ${now}, ${now}
      )
    `;
    await tx.$executeRaw`
      INSERT INTO public."CampaignGroup" ("campaignId", "recipientGroupId", "createdAt")
      VALUES (${campaignId}, ${groupId}, ${now})
    `;

    const reserved = recipients.map((email) => ({
      email,
      recipientId: randomUUID(),
      ledgerId: randomUUID(),
      idempotencyKey: randomUUID(),
    }));
    await tx.$executeRaw`
      INSERT INTO public."Recipient" (
        id, "recipientGroupId", email, "consentStatus", "consentedAt",
        "consentSource", "consentEvidence", "createdAt", "updatedAt"
      ) VALUES ${Prisma.join(reserved.map((recipient) => Prisma.sql`(
        ${recipient.recipientId}, ${groupId}, ${recipient.email}, 'CONFIRMED', ${now},
        'sender_attestation', ${campaignId}, ${now}, ${now}
      )`))}
    `;
    await tx.$executeRaw`
      INSERT INTO public."QuotaLedger" (
        id, "userId", "campaignId", "recipientId", "idempotencyKey", status, "reservedAt"
      ) VALUES ${Prisma.join(reserved.map((recipient) => Prisma.sql`(
        ${recipient.ledgerId}, ${userId}, ${campaignId}, ${recipient.recipientId},
        ${recipient.idempotencyKey}, 'RESERVED', ${now}
      )`))}
    `;

    return {
      status: 200,
      sender: { ...sender, userId },
      reserved,
      skipped: requestedRecipients.length - recipients.length,
    };
  }, { maxWait: 5000, timeout: 15000 });
}

async function markDelivery(idempotencyKey, status) {
  await prisma.quotaLedger.updateMany({
    where: { idempotencyKey, status: 'RESERVED' },
    data: {
      status,
      ...(status === 'SENT' ? { completedAt: new Date() } : {}),
    },
  });
}

async function deliverReserved({ reserved, sender, subject, body, replyTo, publicSiteUrl }) {
  const from = getRelayFrom(sender.displayName);
  let nextIndex = 0;
  let sent = 0;
  let failed = 0;
  const workers = Array.from(
    { length: Math.min(DELIVERY_CONCURRENCY, reserved.length) },
    async () => {
      while (nextIndex < reserved.length) {
        const recipient = reserved[nextIndex];
        nextIndex += 1;
        const unsubscribeToken = createOptOutToken({
          senderUserId: sender.userId || undefined,
          senderEmail: sender.email,
          recipientEmail: recipient.email,
        });
        const unsubscribeUrl = new URL('/api/unsubscribe', publicSiteUrl);
        unsubscribeUrl.searchParams.set('token', unsubscribeToken);
        try {
          await sendEmail({
            to: recipient.email,
            from,
            replyTo,
            subject,
            text: `${body}\n\n---\nYou are receiving this message from a sender using Injestionlike.\nUnsubscribe from this sender: ${unsubscribeUrl.toString()}`,
            html: formatEmailHtml(body, unsubscribeUrl.toString()),
          });
        } catch (error) {
          await markDelivery(recipient.idempotencyKey, 'FAILED');
          failed += 1;
          console.error('Relay recipient delivery failed:', {
            status: error && error.status,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        await markDelivery(recipient.idempotencyKey, 'SENT');
        sent += 1;
      }
    },
  );
  await Promise.all(workers);
  return { sent, failed };
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
  let requestedRecipients;
  try {
    body = parseRequestBody(
      req.body,
      String((req.headers && req.headers['content-type']) || ''),
    );
    if (
      typeof body.from !== 'string' ||
      typeof body.subject !== 'string' ||
      !body.subject.trim() ||
      typeof body.body !== 'string' ||
      !body.body.trim() ||
      !emailPattern.test(body.from.trim()) ||
      /[\r\n]/.test(body.from) ||
      /[\r\n]/.test(body.subject) ||
      body.subject.length > 998 ||
      body.body.length > 100000
    ) {
      throw new TypeError('Message fields are invalid.');
    }
    const lists = {
      to: parseAddressList(body.to),
      cc: parseAddressList(body.cc),
      bcc: parseAddressList(body.bcc),
    };
    if (!lists.to.length) throw new TypeError('At least one To recipient is required.');
    requestedRecipients = [...new Set([...lists.to, ...lists.cc, ...lists.bcc])];
    if (requestedRecipients.length > 1000) {
      throw new TypeError('A send may include at most 1,000 unique recipients.');
    }
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

  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return res.status(503).json({ error: 'Outbound email delivery is not configured.' });
  }
  let publicSiteUrl;
  try {
    publicSiteUrl = getPublicSiteUrl();
    if (!emailPattern.test(process.env.EMAIL_FROM.trim()) ||
        /[\r\n]/.test(process.env.EMAIL_FROM)) {
      throw new Error('EMAIL_FROM is not configured correctly.');
    }
    const optOutSecret = process.env.ACTIVATION_CODE_SECRET || process.env.SESSION_SECRET;
    if (!optOutSecret || Buffer.byteLength(optOutSecret, 'utf8') < 32) {
      throw new Error('A 32-byte opt-out signing secret is required.');
    }
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }

  try {
    const reserved = await reserveRecipients({
      userId,
      senderAddress: body.from.trim().toLowerCase(),
      requestedRecipients,
    });
    if (reserved.status !== 200) {
      return res.status(reserved.status).json({ error: reserved.error });
    }
    if (!reserved.reserved.length) {
      return res.status(200).json({
        message: 'No eligible recipients remained after sender-specific opt-outs and suppression filtering.',
        sent: 0,
        skipped: reserved.skipped,
        failed: 0,
      });
    }

    const replyTo = body.replyTo ? body.replyTo.trim().toLowerCase() : reserved.sender.email;
    const delivery = await deliverReserved({
      ...reserved,
      subject: body.subject.trim(),
      body: body.body,
      replyTo,
      publicSiteUrl,
    });
    const result = {
      sent: delivery.sent,
      skipped: reserved.skipped,
      failed: delivery.failed,
      message: delivery.failed
        ? `Delivered to ${delivery.sent} recipient(s); ${delivery.failed} delivery attempt(s) failed.`
        : `Delivered to ${delivery.sent} recipient(s).`,
    };
    return res.status(delivery.sent ? 200 : 502).json(result);
  } catch (error) {
    console.error('Mailer request could not be completed:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error.code === 'string' ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Message submission could not be completed.' });
  }
};

module.exports.parseAddressList = parseAddressList;
module.exports.escapeHtml = escapeHtml;
module.exports.formatEmailHtml = formatEmailHtml;
