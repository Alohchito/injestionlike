const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// Vercel requires this config to read raw Stripe signatures correctly
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper function to read the raw body from Vercel's request stream
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Cryptographically checks the signature using your Vercel environment variable
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`❌ Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: Verification Failed`);
  }

  // Handle a successful monthly subscription payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    if (session.payment_status === 'paid') {
      const customerEmail = session.customer_details?.email;
      
      const metadataVolume = Number(session.metadata?.volume_tier);
      const hasValidVolume =
        Number.isInteger(metadataVolume) &&
        metadataVolume >= 1000 &&
        metadataVolume <= 10000 &&
        metadataVolume % 1000 === 0;
      const selectedPlan = session.metadata?.plan || '1000_emails';
      const legacyDailyLimits = {
        '1000_emails': 1000,
        '2000_emails': 2000,
        '3000_emails': 3000,
        '10000_emails': 10000,
      };
      const dailyLimit = hasValidVolume
        ? metadataVolume
        : legacyDailyLimits[selectedPlan] || 1000;
      const metadataMonths = Number(session.metadata?.months);
      const commitmentMonths =
        Number.isInteger(metadataMonths) && metadataMonths >= 1 && metadataMonths <= 12
          ? metadataMonths
          : null;

      console.log(
        `🔒 Payment verified for ${customerEmail}. Plan: ${dailyLimit}/day` +
          (commitmentMonths ? ` for ${commitmentMonths} months.` : '.'),
      );

      // Generate a highly secure activation code
      const crypto = require('crypto');
      const activationCode = `ACT-${crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}`;

      try {
        // TODO: Update user account in Prisma database:
        // 1. Mark account as active
        // 2. Save the activationCode
        // 3. Set their daily email sending limit to dailyLimit
        
        return res.status(200).json({ received: true, status: "ACTIVATED", code: activationCode, dailyLimit });
      } catch (dbError) {
        console.error('❌ Database update failed:', dbError);
        return res.status(500).send('Database storage failure');
      }
    }
  }

  res.json({ received: true });
}
