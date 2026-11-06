const Stripe = require('stripe');

const BASE_RATE_BY_VOLUME = {
  1000: 19,
  2000: 35,
  3000: 45,
  4000: 49,
  5000: 65,
  6000: 69,
  7000: 73,
  8000: 77,
  9000: 81,
  10000: 85,
};

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

function getRequestValue(req, key) {
  return req.query?.[key] ?? req.body?.[key];
}

function getDiscountMultiplier(months) {
  if (months >= 12) return 0.65;
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const volumeTier = parseInteger(getRequestValue(req, 'volume_tier'));
  const months = parseInteger(getRequestValue(req, 'months'));

  if (
    volumeTier === null ||
    volumeTier < 1000 ||
    volumeTier > 10000 ||
    volumeTier % 1000 !== 0
  ) {
    return res.status(400).json({
      error: 'volume_tier must be an integer from 1000 to 10000 in steps of 1000.',
    });
  }

  if (months === null || months < 1 || months > 12) {
    return res.status(400).json({
      error: 'months must be an integer from 1 to 12.',
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not configured.');
    return res.status(500).json({ error: 'Checkout is not configured.' });
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const monthlyBaseRate = BASE_RATE_BY_VOLUME[volumeTier];
    const durationMultiplier = getDiscountMultiplier(months);
    const totalAmount = Math.round(
      monthlyBaseRate * months * durationMultiplier * 100,
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

    return res.redirect(303, session.url);
  } catch (error) {
    console.error('Stripe Checkout session creation failed:', error);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
}
