const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

export default async function handler(req, res) {
  // 1. Securely check that the method matches our frontend POST request
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Please use a POST request.' });
  }

  try {
    // 2. Read the selected volume and months chosen by the customer
    const { volume_tier, months } = req.body;

    const volume = parseInt(volume_tier, 10);
    const durationMonths = parseInt(months, 10);

    // 3. Mathematical validation rules (Minimum 1000, Maximum 10000)
    if (!volume || volume < 1000 || volume > 10000 || volume % 1000 !== 0) {
      return res.status(400).json({ error: 'volume_tier must be an integer from 1000 to 10000 in steps of 1000.' });
    }

    // 4. Calculate Base Monthly Volume Tier Rate
    let monthlyRate = 19; // 1,000 emails/day baseline
    if (volume === 2000) monthlyRate = 35;
    if (volume === 3000) monthlyRate = 45;
    if (volume === 4000) monthlyRate = 49;
    if (volume === 5000) monthlyRate = 65;
    if (volume === 10000) monthlyRate = 85;

    // 5. Apply Commitment Length Milestone Discount Multipliers
    let durationMultiplier = 1.0;
    if (durationMonths >= 3 && durationMonths <= 5) durationMultiplier = 0.85; // 15% off
    if (durationMonths >= 6 && durationMonths <= 11) durationMultiplier = 0.75; // 25% off
    if (durationMonths === 12) durationMultiplier = 0.65; // 35% off

    // 6. Final Upfront Cash Total in Cents
    const finalTotalCents = Math.round(monthlyRate * durationMonths * durationMultiplier * 100);

    // 7. Instantiate Stripe Checkout Session Wrapper
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${volume.toLocaleString()} Emails/Day Subscription Pass`,
            description: `${durationMonths}-Month access tier plan pass pass`,
          },
          unit_amount: finalTotalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://vercel.app{CHECKOUT_SESSION_ID}`,
      cancel_url: `https://injestionlike.vercel.app/`,
      // Crucial: Pass metadata metrics so webhook.js can automatically unlock user limits!
      metadata: {
        volume_limit: volume.toString(),
        commitment_months: durationMonths.toString(),
      },
    });

    // Send the user directly to the secure checkout page
    return res.redirect(333, session.url);

  } catch (error) {
    console.error('❌ Checkout session generation failure:', error.message);
    return res.status(500).json({ error: 'Could not communicate with Stripe portal.' });
  }
}