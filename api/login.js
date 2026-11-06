import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function handler(req, res) {
  // Only accept POST requests from our HTML form
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).send('<h1>Error</h1><p>Please enter both email and password.</p>');
    }

    // Look for the user account record in your Prisma database
    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Check if the user exists and the password matches
    if (!user || user.password !== password) {
      return res.status(401).send('<h1>Authentication Failed</h1><p>Invalid email or password.</p>');
    }

    console.log(`🔒 User logged in successfully: ${user.email}`);

    // If they haven't paid yet, redirect them to finish their checkout payment setup
    if (!user.isActiveCustomer) {
      return res.send(`
        <html>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#0f172a; color:#fff;">
            <h2 style="color:#6366f1;">Welcome Back!</h2>
            <p>Your email is registered but your premium package plan is not active yet.</p>
            <a href="https://vercel.app" style="color:#10b981; font-weight:bold; text-decoration:none;">Pick a Plan & Pay Now &rarr;</a>
          </body>
        </html>
      `);
    }

    // SUCCESS: They are verified and have paid, grant access to the application bulk dashboard
    return res.send(`
      <html>
        <body style="font-family:sans-serif; text-align:center; padding:50px; background:#0f172a; color:#fff;">
          <h2 style="color:#10b981;">🚀 Access Granted to Bulk Platform Dashboard!</h2>
          <p>Logged in as: <strong>${user.email}</strong></p>
          <p>Your current daily email limitation tier is: <strong>${user.dailyEmailLimit} emails/day</strong></p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('❌ Login processing error:', error);
    return res.status(500).send('Internal Server Processing Error');
  }
}
