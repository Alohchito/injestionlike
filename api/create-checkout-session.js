const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Please use a POST request.' });
  }

  try {
    let volume_tier = req.body.volume_tier;
    let months = req.body.months;

    const volume = parseInt(volume_tier, 10);
    const durationMonths = parseInt(months, 10);

    if (!volume || volume < 1000 || volume > 10000) {
      return res.status(400).json({ error: 'volume_tier must be an integer from 1000 to 10000.' });
    }

    let monthlyRate = 19; 
    if (volume === 2000) monthlyRate = 35;
    if (volume === 3000) monthlyRate = 45;
    if (volume === 4000) monthlyRate = 49;
    if (volume === 5000) monthlyRate = 65;
    if (volume === 10000) monthlyRate = 85;

    let durationMultiplier = 1.0;
    if (durationMonths >= 3 && durationMonths <= 5) durationMultiplier = 0.85; 
    if (durationMonths >= 6 && durationMonths <= 11) durationMultiplier = 0.75; 
    if (durationMonths === 12) durationMultiplier = 0.65; 

    const finalTotalCents = Math.round(monthlyRate * durationMonths * durationMultiplier * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${volume.toLocaleString()} Emails/Day Plan`,
            description: `${durationMonths}-Month Subscription`,
          },
          unit_amount: finalTotalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://vercel.app`,
      cancel_url: `https://vercel.app`,
      metadata: {
        volume_limit: volume.toString(),
        commitment_months: durationMonths.toString(),
      },
    });

    return res.redirect(333, session.url);

  } catch (error) {
    console.error('❌ Checkout error:', error.message);
    return res.status(500).json({ error: 'Could not communicate with Stripe.' });
  }
}
