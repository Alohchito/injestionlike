const {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return null;
}

async function parseJsonResponse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Payment verification failed with status ${response.status}.`);
  }
  return body;
}

function verifyFedaPaySignature(rawBody, header, secret) {
  if (typeof header !== 'string' || !secret) return false;

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 's' && value) {
      signatures.push(value);
    }
  }
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`, 'utf8')
    .digest('hex');
  return signatures.some((signature) => safeEqual(signature.toLowerCase(), expected));
}

async function verifyFlutterwaveTransaction(transactionId) {
  const secret = process.env.FLW_SECRET_KEY;
  if (!secret) throw new Error('FLW_SECRET_KEY is not configured.');

  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  const body = await parseJsonResponse(response);
  if (!body || body.status !== 'success' || !body.data) {
    throw new Error('Flutterwave did not verify the transaction.');
  }
  return body.data;
}

function fedaPayBaseUrl() {
  if (process.env.FEDAPAY_ENVIRONMENT === 'sandbox') {
    return 'https://sandbox-api.fedapay.com/v1';
  }
  if (process.env.FEDAPAY_ENVIRONMENT === 'live') {
    return 'https://api.fedapay.com/v1';
  }
  throw new Error('FEDAPAY_ENVIRONMENT must be sandbox or live.');
}

async function fedaPayGet(path) {
  const secret = process.env.FEDAPAY_SECRET_KEY;
  if (!secret) throw new Error('FEDAPAY_SECRET_KEY is not configured.');

  const response = await fetch(`${fedaPayBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  return parseJsonResponse(response);
}

function unwrapEntity(payload, keys) {
  if (!payload || typeof payload !== 'object') return payload;
  for (const key of keys) {
    if (payload[key] && typeof payload[key] === 'object') {
      return unwrapEntity(payload[key], keys);
    }
  }
  return payload;
}

async function verifyFedaPayTransaction(transactionId) {
  const payload = await fedaPayGet(
    `/transactions/${encodeURIComponent(transactionId)}`,
  );
  const transaction = unwrapEntity(payload, ['transaction', 'data', 'v1/transaction']);
  if (!transaction || String(transaction.id) !== String(transactionId)) {
    throw new Error('FedaPay did not verify the transaction.');
  }

  let currency =
    transaction.currency && (transaction.currency.iso || transaction.currency.code);
  if (!currency && transaction.currency_id != null) {
    const currencyPayload = await fedaPayGet(
      `/currencies/${encodeURIComponent(transaction.currency_id)}`,
    );
    const currencyEntity = unwrapEntity(currencyPayload, [
      'currency',
      'data',
      'v1/currency',
    ]);
    currency =
      currencyEntity &&
      (currencyEntity.iso || currencyEntity.code || currencyEntity.currency);
  }

  const metadata =
    transaction.custom_metadata || transaction.metadata || {};
  return {
    id: String(transaction.id),
    status: transaction.status,
    amount: Number(transaction.amount),
    currency: typeof currency === 'string' ? currency.toUpperCase() : null,
    reference:
      metadata.checkoutSessionId ||
      transaction.merchant_reference ||
      transaction.reference,
  };
}

function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

async function applyVerifiedPayment({
  provider,
  providerEventId,
  eventType,
  providerPaymentId,
  checkoutSessionId,
  amount,
  currency,
}) {
  const subscription = await prisma.subscription.findUnique({
    where: {
      provider_checkoutSessionId: { provider, checkoutSessionId },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      paymentStatus: true,
      amount: true,
      currency: true,
      durationMonths: true,
      providerPaymentId: true,
    },
  });
  if (!subscription) return { found: false };

  const expectedAmount = Number(subscription.amount);
  if (
    !Number.isFinite(amount) ||
    amount !== expectedAmount ||
    currency !== subscription.currency
  ) {
    throw new Error('Verified transaction amount or currency does not match the order.');
  }
  if (
    subscription.providerPaymentId &&
    subscription.providerPaymentId !== providerPaymentId
  ) {
    throw new Error('Verified transaction ID does not match the order.');
  }

  if (subscription.paymentStatus === 'PAID') {
    await prisma.paymentEvent.upsert({
      where: { provider_providerEventId: { provider, providerEventId } },
      update: {},
      create: {
        subscriptionId: subscription.id,
        provider,
        providerEventId,
        eventType,
      },
    });
    return { found: true, alreadyPaid: true };
  }
  if (subscription.status !== 'PENDING') {
    throw new Error('Payment refers to a subscription that is not pending.');
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.updateMany({
      where: {
        id: subscription.id,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        providerPaymentId: subscription.providerPaymentId || null,
      },
      data: {
        status: 'ACTIVE',
        paymentStatus: 'PAID',
        providerPaymentId,
        paidAt: now,
        startsAt: now,
        expiresAt: addMonths(now, subscription.durationMonths),
      },
    });

    if (updated.count === 0) {
      const current = await tx.subscription.findUnique({
        where: { id: subscription.id },
        select: { status: true, paymentStatus: true, providerPaymentId: true },
      });
      if (
        !current ||
        current.status !== 'ACTIVE' ||
        current.paymentStatus !== 'PAID' ||
        current.providerPaymentId !== providerPaymentId
      ) {
        throw new Error('Subscription state changed before payment could be applied.');
      }

      await tx.paymentEvent.upsert({
        where: {
          provider_providerEventId: { provider, providerEventId },
        },
        update: {},
        create: {
          subscriptionId: subscription.id,
          provider,
          providerEventId,
          eventType,
        },
      });
      return { found: true, alreadyPaid: true };
    }

    await tx.paymentEvent.create({
      data: {
        subscriptionId: subscription.id,
        provider,
        providerEventId,
        eventType,
      },
    });
    const activation = await tx.user.updateMany({
      where: {
        id: subscription.userId,
        status: { not: 'SUSPENDED' },
        emailVerifiedAt: { not: null },
        activationCode: null,
      },
      data: {
        status: 'ACTIVE',
        activatedAt: now,
        activationCode: `ACT-${randomBytes(6).toString('hex').toUpperCase()}`,
      },
    });
    if (activation.count === 0) {
      const account = await tx.user.findUnique({
        where: { id: subscription.userId },
        select: { status: true, emailVerifiedAt: true, activationCode: true },
      });
      if (
        !account ||
        account.status === 'SUSPENDED' ||
        !account.emailVerifiedAt ||
        !account.activationCode
      ) {
        throw new Error('Verified account could not be activated after payment.');
      }
      await tx.user.update({
        where: { id: subscription.userId },
        data: { status: 'ACTIVE', activatedAt: now },
      });
    }
    return { found: true, alreadyPaid: false };
  });
}

async function processMockPayment(req, res, rawBody) {
  const secret = process.env.MOCK_PAYMENT_WEBHOOK_SECRET;
  const allowed =
    process.env.NODE_ENV !== 'production' &&
    process.env.VERCEL_ENV !== 'production' &&
    process.env.TEST_MODE_MOCK_PAYMENTS === 'true';
  if (!allowed || !secret || !safeEqual(req.headers['x-test-mock-secret'], secret)) {
    return res.status(401).send('Mock payment callbacks are disabled.');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return res.status(400).send('Invalid mock payment payload.');
  }
  if (typeof event.checkoutSessionId !== 'string' || !event.checkoutSessionId) {
    return res.status(400).send('Checkout reference is required.');
  }

  const subscription = await prisma.subscription.findFirst({
    where: {
      checkoutSessionId: event.checkoutSessionId,
      status: 'PENDING',
      paymentStatus: 'PENDING',
    },
    select: {
      provider: true,
      amount: true,
      currency: true,
    },
  });
  if (!subscription) return res.status(404).send('Pending payment was not found.');

  const result = await applyVerifiedPayment({
    provider: subscription.provider,
    providerEventId: `test:${randomUUID()}`,
    eventType: 'test.payment.succeeded',
    providerPaymentId: `test:${randomUUID()}`,
    checkoutSessionId: event.checkoutSessionId,
    amount: Number(subscription.amount),
    currency: subscription.currency,
  });
  if (!result.found) return res.status(404).send('Pending payment was not found.');
  return res.status(200).json({ received: true, testMode: true });
}

async function processFlutterwave(req, res, rawBody) {
  const secretHash = process.env.FLW_SECRET_HASH;
  if (!secretHash) {
    console.error('FLW_SECRET_HASH is not configured.');
    return res.status(500).send('Flutterwave webhook is not configured.');
  }
  if (!safeEqual(req.headers['verif-hash'], secretHash)) {
    return res.status(401).send('Invalid webhook signature.');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return res.status(400).send('Invalid webhook payload.');
  }

  if (
    event.event !== 'charge.completed' ||
    !event.data ||
    event.data.status !== 'successful' ||
    event.data.id == null
  ) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const verified = await verifyFlutterwaveTransaction(event.data.id);
  if (
    verified.status !== 'successful' ||
    String(verified.id) !== String(event.data.id) ||
    verified.tx_ref !== event.data.tx_ref ||
    !verified.tx_ref
  ) {
    return res.status(400).send('Flutterwave transaction verification failed.');
  }

  const result = await applyVerifiedPayment({
    provider: 'FLUTTERWAVE',
    providerEventId: `${verified.id}:successful`,
    eventType: event.event,
    providerPaymentId: String(verified.id),
    checkoutSessionId: verified.tx_ref,
    amount: Number(verified.amount),
    currency: String(verified.currency || '').toUpperCase(),
  });
  if (!result.found) return res.status(404).send('Payment reference was not found.');
  return res.status(200).json({ received: true, alreadyProcessed: result.alreadyPaid });
}

async function processFedaPay(req, res, rawBody) {
  const endpointSecret = process.env.FEDAPAY_WEBHOOK_SECRET;
  if (!endpointSecret) {
    console.error('FEDAPAY_WEBHOOK_SECRET is not configured.');
    return res.status(500).send('FedaPay webhook is not configured.');
  }

  if (
    !verifyFedaPaySignature(
      rawBody,
      req.headers['x-fedapay-signature'],
      endpointSecret,
    )
  ) {
    return res.status(401).send('Invalid webhook signature.');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return res.status(400).send('Invalid webhook payload.');
  }

  if (event.name !== 'transaction.approved') {
    return res.status(200).json({ received: true, ignored: true });
  }
  const eventEntity =
    event.entity ||
    (event.data && (event.data.entity || event.data.object || event.data));
  if (!eventEntity || eventEntity.id == null) {
    return res.status(400).send('FedaPay transaction ID is missing.');
  }

  const verified = await verifyFedaPayTransaction(eventEntity.id);
  if (
    verified.status !== 'approved' ||
    !verified.reference ||
    verified.currency !== 'XOF'
  ) {
    return res.status(400).send('FedaPay transaction verification failed.');
  }

  const result = await applyVerifiedPayment({
    provider: 'FEDAPAY',
    providerEventId: `${verified.id}:approved`,
    eventType: event.name,
    providerPaymentId: verified.id,
    checkoutSessionId: String(verified.reference),
    amount: verified.amount,
    currency: verified.currency,
  });
  if (!result.found) return res.status(404).send('Payment reference was not found.');
  return res.status(200).json({ received: true, alreadyProcessed: result.alreadyPaid });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }
  return res.status(410).json({ error: 'Online payment webhooks are disabled.' });

  const rawBody = getRawBody(req);
  if (!rawBody) return res.status(400).send('Webhook body must be raw JSON.');

  try {
    if (req.headers['x-test-mock-secret']) {
      return await processMockPayment(req, res, rawBody);
    }
    if (req.headers['x-fedapay-signature']) {
      return await processFedaPay(req, res, rawBody);
    }
    if (req.headers['verif-hash']) {
      return await processFlutterwave(req, res, rawBody);
    }
    return res.status(401).send('Webhook signature is missing.');
  } catch (error) {
    console.error('Payment webhook processing failed:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && error.code,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).send('Payment webhook processing failed.');
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
module.exports.verifyFedaPaySignature = verifyFedaPaySignature;
