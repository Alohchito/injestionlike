import Stripe from 'stripe';

// This directly accesses the real variable you already saved in your Vercel Dashboard
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const volume_tier = req.body.volume_tier || req.query.volume_tier;
    const months = req.body.months || req.query.months;

    const volume = parseInt(volume_tier, 10);
    const durationMonths = parseInt(months, 10);

    if (!volume || volume < 1000 || volume > 10000) {
      return res.status(400).json({ error: 'Invalid volume selection.' });
    }

    let monthlyRate = 19; 
    if (volume === 2000) monthlyRate = 35;
    if (volume === 3000) monthlyRate = 45;
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
            name: `${volume.toLocaleString()} Emails/Day Subscription Pass`,
            description: `${durationMonths}-Month access tier plan pass`,
          },
          unit_amount: finalTotalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://injestionlike.vercel.app/`,
      cancel_url: `https://injestionlike.vercel.app/`,
      metadata: {
        volume_limit: volume.toString(),
        commitment_months: durationMonths.toString(),
      },
    });

    // Instead of forcing a raw browser redirect that can show errors, 
    // we send the URL back to our webpage to open it cleanly and safely
    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('❌ Stripe Connection Error:', error.message);
    return res.status(500).json({ error: 'Secure payment gateway busy. Please try again.' });
  }
}