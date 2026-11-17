const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { getSessionUserId } = require('../utils/session');
const { parseRequestBody } = require('../utils/request-body');

const prisma = new PrismaClient();
const MONTHLY_USD_RATES = Object.freeze({
  1000: 19,
  2000: 35,
  3000: 45,
  5000: 65,
  10000: 85,
});
const USD_EXCHANGE_RATES = Object.freeze({
  USD: 1,
  NGN: 1600,
  GHS: 15,
  XOF: 600,
});
const COUNTRY_CURRENCY = Object.freeze({
  NG: 'NGN',
  GH: 'GHS',
  BF: 'XOF',
  CI: 'XOF',
  BJ: 'XOF',
  GW: 'XOF',
  ML: 'XOF',
  NE: 'XOF',
  SN: 'XOF',
  TG: 'XOF',
});
const PLAN_MONTHS = new Set([1, 3, 6, 12]);
const FLUTTERWAVE_METHODS = Object.freeze({
  NG: {
    card: 'card',
    bank_transfer: 'banktransfer',
    ussd: 'ussd',
  },
  GH: {
    card: 'card',
    mobile_money: 'ghanamobilemoney',
  },
});

function parseInteger(value) {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^\d+$/.test(String(value))
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function getDiscountMultiplier(months) {
  if (months === 12) return 0.65;
  if (months >= 6) return 0.75;
  if (months >= 3) return 0.85;
  return 1;
}

function getBaseUrl() {
  const configuredUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.APP_URL ||
      (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000');
  const url = new URL(configuredUrl);
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username ||
    url.password
  ) {
    throw new Error('APP_URL must use HTTPS, except for localhost development.');
  }
  return url.origin;
}

function getQuote(volumeTier, months, countryCode) {
  const currency = COUNTRY_CURRENCY[countryCode] || 'USD';
  const baseUsd = MONTHLY_USD_RATES[volumeTier] * months * getDiscountMultiplier(months);
  const precision = currency === 'XOF' ? 0 : 2;
  const multiplier = 10 ** precision;
  const amount =
    Math.round(baseUsd * USD_EXCHANGE_RATES[currency] * multiplier) / multiplier;
  return { amount, baseUsd, currency };
}

function getProviderRoute(countryCode, paymentMethod) {
  if (['BF', 'CI', 'BJ', 'GW', 'ML', 'NE', 'SN', 'TG'].includes(countryCode)) {
    if (!['orange_money', 'moov_money'].includes(paymentMethod)) {
      throw new Error('Choose Orange Money or Moov Money for this country.');
    }

    const enabledCountries = String(process.env.FEDAPAY_ENABLED_COUNTRIES || '')
      .split(',')
      .map((country) => country.trim().toUpperCase())
      .filter(Boolean);
    const operator = paymentMethod === 'orange_money' ? 'ORANGE_MONEY' : 'MOOV_MONEY';
    const mode =
      process.env[`FEDAPAY_MODE_${countryCode}_${operator}`] ||
      process.env[`FEDAPAY_MODE_${operator}`];
    if (!enabledCountries.includes(countryCode) || !mode) {
      throw new Error(
        'FedaPay is not enabled for this country and payment method. Confirm merchant support and configure its approved mode first.',
      );
    }
    return { provider: 'FEDAPAY', paymentMethod, mode };
  }

  if (countryCode === 'NG' || countryCode === 'GH') {
    const paymentOption = FLUTTERWAVE_METHODS[countryCode][paymentMethod];
    if (!paymentOption) {
      throw new Error('That payment method is not configured for this country.');
    }
    return { provider: 'FLUTTERWAVE', paymentMethod, paymentOption };
  }

  if (paymentMethod !== 'card') {
    throw new Error('Only card payments are configured for this country.');
  }
  return { provider: 'FLUTTERWAVE', paymentMethod, paymentOption: 'card' };
}

async function postJson(url, secret, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Payment provider request failed with status ${response.status}.`);
  }
  return payload;
}

async function createFlutterwaveCheckout(subscription, user, route, baseUrl) {
  const secret = process.env.FLW_SECRET_KEY;
  if (!secret) throw new Error('FLW_SECRET_KEY is not configured.');

  const response = await postJson('https://api.flutterwave.com/v3/payments', secret, {
    tx_ref: subscription.checkoutSessionId,
    amount: Number(subscription.amount),
    currency: subscription.currency,
    redirect_url: `${baseUrl}/?checkout=return`,
    payment_options: route.paymentOption,
    customer: { email: user.email },
    meta: { subscription_id: subscription.id },
    session_duration: 30,
    max_retry_attempt: 3,
  });
  const link = response && response.data && response.data.link;
  if (response.status !== 'success' || typeof link !== 'string') {
    throw new Error('Flutterwave did not return a checkout link.');
  }
  return { url: link, providerPaymentId: null };
}

function getFedaPayBaseUrl() {
  const environment = process.env.FEDAPAY_ENVIRONMENT;
  if (environment === 'sandbox') return 'https://sandbox-api.fedapay.com/v1';
  if (environment === 'live') return 'https://api.fedapay.com/v1';
  throw new Error('FEDAPAY_ENVIRONMENT must be sandbox or live.');
}

async function createFedaPayCheckout(subscription, user, route, baseUrl) {
  const secret = process.env.FEDAPAY_SECRET_KEY;
  if (!secret) throw new Error('FEDAPAY_SECRET_KEY is not configured.');

  const apiBase = getFedaPayBaseUrl();
  const created = await postJson(`${apiBase}/transactions`, secret, {
    description: `${subscription.emailsPer24Hours} emails/day for ${subscription.durationMonths} months`,
    amount: Number(subscription.amount),
    currency: { iso: subscription.currency },
    callback_url: `${baseUrl}/?checkout=return`,
    mode: route.mode,
    custom_metadata: { checkoutSessionId: subscription.checkoutSessionId },
    customer: { email: user.email },
  });
  const transaction =
    created && (created.transaction || created.data || created['v1/transaction'] || created);
  if (!transaction || transaction.id == null) {
    throw new Error('FedaPay did not return a transaction ID.');
  }

  const tokenResult = await postJson(
    `${apiBase}/transactions/${encodeURIComponent(transaction.id)}/token`,
    secret,
    {},
  );
  const token =
    tokenResult &&
    (tokenResult.token || tokenResult.data || tokenResult['v1/transaction/token'] || tokenResult);
  if (!token || typeof token.url !== 'string') {
    throw new Error('FedaPay did not return a checkout link.');
  }
  return { url: token.url, providerPaymentId: String(transaction.id) };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }
  return res.status(410).json({
    error: 'Online checkout is disabled. Submit a manual-payment order from your dashboard.',
  });

  let userId;
  try {
    userId = getSessionUserId(req);
  } catch (error) {
    console.error('Checkout session configuration error:', error.message);
    return res.status(500).send('Checkout is not configured.');
  }
  if (!userId) return res.status(401).send('Please log in before choosing a plan.');

  let body;
  try {
    body = parseRequestBody(
      req.body,
      String((req.headers && req.headers['content-type']) || ''),
    );
  } catch (error) {
    return res.status(400).send('Invalid checkout request body.');
  }

  const volumeTier = parseInteger(body.volume_tier);
  const months = parseInteger(body.months);
  const requestedCountry =
    typeof body.countryCode === 'string' ? body.countryCode.trim().toUpperCase() : '';
  const paymentMethod =
    typeof body.paymentMethod === 'string' ? body.paymentMethod.trim().toLowerCase() : '';

  if (!Object.prototype.hasOwnProperty.call(MONTHLY_USD_RATES, volumeTier)) {
    return res.status(400).send('Please select a valid email volume tier.');
  }
  if (!PLAN_MONTHS.has(months)) {
    return res.status(400).send('Please select a valid commitment length.');
  }
  if (!/^[A-Z]{2}$/.test(requestedCountry)) {
    return res.status(400).send('Please select a valid billing country.');
  }

  let route;
  try {
    route = getProviderRoute(requestedCountry, paymentMethod);
  } catch (error) {
    return res.status(400).send(error.message);
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, emailVerifiedAt: true },
    });
    if (!user || user.status === 'SUSPENDED') {
      return res.status(403).send('This account cannot start checkout.');
    }
    if (!user.emailVerifiedAt) {
      return res.status(403).send('Verify your email before starting checkout.');
    }

    const { amount, currency } = getQuote(volumeTier, months, requestedCountry);
    const baseUrl = getBaseUrl();
    const checkoutSessionId = randomUUID();
    const subscription = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { countryCode: requestedCountry },
      });
      return tx.subscription.create({
        data: {
          userId: user.id,
          status: 'PENDING',
          paymentStatus: 'PENDING',
          currency,
          amount,
          provider: route.provider,
          paymentMethod: route.paymentMethod,
          countryCode: requestedCountry,
          emailsPer24Hours: volumeTier,
          durationMonths: months,
          checkoutSessionId,
        },
      });
    });
    try {
      const checkout =
        route.provider === 'FLUTTERWAVE'
          ? await createFlutterwaveCheckout(subscription, user, route, baseUrl)
          : await createFedaPayCheckout(subscription, user, route, baseUrl);

      if (checkout.providerPaymentId) {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { providerPaymentId: checkout.providerPaymentId },
        });
      }
      return res.redirect(303, checkout.url);
    } catch (error) {
      console.error('Checkout provider initialization failed:', {
        provider: route.provider,
        subscriptionId: subscription.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).send('Could not start payment checkout.');
    }
  } catch (error) {
    console.error('Checkout processing failed:', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && error.code,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).send('Checkout could not be created.');
  }
};

module.exports.getQuote = getQuote;
module.exports.getProviderRoute = getProviderRoute;
