const Stripe = require('stripe');

const MONTHLY_RATES = {
  1000: 19,
  2000: 35,
  3000: 45,
  5000: 65,
  10000: 85,
};

function parseRequestBody(body, contentType) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    body = body.toString('utf8');
  }

  if (typeof body !== 'string' || body.length === 0) {
    return {};
  }

  if (contentType.includes('application/json')) {
    return JSON.parse(body);
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }

  throw new Error('Unsupported request content type.');
}

function parseInteger(value) {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^\d+$/.test(String(value))
  ) {
    return null;
  }

  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

function getDiscountMultiplier(months) {
  if (months === 12) return 0.65;
  if (months >= 6) return 0.75;
  if (months >= 3) return 0.85;
  return 1;
}

function getBaseUrl() {
  const configuredUrl =
    process.env.APP_URL ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000');
  const url = new URL(configuredUrl);
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');

  if (
    (url.protocol !== 'https:' && !isLocalHttp) ||
    url.username ||
    url.password
  ) {
    throw new Error('APP_URL must use HTTPS, except for localhost development.');
  }

  return url.origin;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  let body;
  try {
    body = parseRequestBody(
      req.body,
      String(req.headers['content-type'] || '').toLowerCase(),
    );
  } catch (error) {
    return res.status(400).send('Invalid checkout request body.');
  }

  const volumeTier = parseInteger(body.volume_tier ?? req.query?.volume_tier);
  const months = parseInteger(body.months ?? req.query?.months);

  if (!Object.prototype.hasOwnProperty.call(MONTHLY_RATES, volumeTier)) {
    return res.status(400).send('Please select a valid email volume tier.');
  }

  if (![1, 3, 6, 12].includes(months)) {
    return res.status(400).send('Please select a valid commitment length.');
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not configured.');
    return res.status(500).send('Checkout is not configured.');
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const totalAmount = Math.round(
      MONTHLY_RATES[volumeTier] * months * getDiscountMultiplier(months) * 100,
    );
    const baseUrl = getBaseUrl();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${volumeTier.toLocaleString()} emails/day for ${months} months`,
            },
            unit_amount: totalAmount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        volume_tier: String(volumeTier),
        months: String(months),
      },
      success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
    });

    if (!session.url) {
      console.error('Stripe created a Checkout Session without a redirect URL.');
      return res.status(502).send('Stripe could not provide a checkout link.');
    }

    return res.redirect(303, session.url);
  } catch (error) {
    console.error('Stripe Checkout session creation failed:', error);
    return res.status(502).send('Could not communicate with Stripe.');
  }
};
