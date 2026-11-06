require('dotenv').config();
const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const crypto = require('crypto'); // Built into Node.js to make random secure codes

const app = express();

// 1. Serve your new visual homepage layout
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Route to create a real Stripe Checkout payment link when they click the button
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Premium Activation Pass',
            description: 'Lifetime email forwarding activation key',
          },
          unit_amount: 1900, // $19.00 in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://vercel.app{CHECKOUT_SESSION_ID}`,
      cancel_url: `https://injestionlike.vercel.app/`,
    });
    res.redirect(333, session.url);
  } catch (error) {
    console.error("Error building checkout session:", error.message);
    res.status(500).send("Could not open checkout page.");
  }
});

// 3. SECURE WEBHOOK: Stripe pings this when a payment is 100% verified
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // SECURITY WALL: This strictly checks the signature using your Vercel secret variable.
    // If a malicious user tries to fake a payment message, this line instantly throws an error and stops!
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`❌ SECURITY ALERT: Fake or Invalid Webhook Attempt blocked:`, err.message);
    return res.status(400).send(`Webhook Error: Verification Failed`);
  }

  // Double Check: Only execute if Stripe confirms payment is successfully complete
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Extra safety layer: Verify that the payment status is actually 'paid'
    if (session.payment_status === 'paid') {
      const customerEmail = session.customer_details?.email;
      console.log(`🔒 Payment verified for ${customerEmail}. Generating key...`);

      // SECURITY KEY GENERATION: Creates a unique key like ACT-A7F2-9D8B-E3C1
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const activationCode = `ACT-${part1}-${part2}-${part3}`;

      console.log(`🎯 Key Generated Successfully: [${activationCode}] for user: ${customerEmail}`);

      try {
        // TODO: Insert your code here to save activationCode to Prisma database 
        // and send out your activationEmailTemplate.ts to the customerEmail.
        
        return res.json({ received: true, status: "ACTIVATED", code: activationCode });
      } catch (dbError) {
        console.error('❌ Failed saving activation to database:', dbError);
        return res.status(500).send('Database storage failure');
      }
    } else {
      console.log('⚠️ Payment session received but status is not fully paid.');
      return res.json({ received: true, status: "UNPAID_IGNORED" });
    }
  } else {
    res.json({ received: true });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server live on http://localhost:${PORT}`));
