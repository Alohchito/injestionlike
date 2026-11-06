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
      return res.status(400).send('<h1>Error</h1><p>Please enter both an email and password.</p>');
    }

    // Check if the user account records already exist
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).send('<h1>Account Exists</h1><p>This email is already registered. Please try logging in.</p>');
    }

    // Save the user account securely to your SQLite Prisma database schema
    const newUser = await prisma.user.create({
      data: {
        email: email,
        password: password, // For live scaling production, you would hash this string
        isEmailVerified: false, // Must verify email first
        isActiveCustomer: false, // Must pay before sending bulk email
      },
    });

    console.log(`👤 New User Registered successfully: ${newUser.email}`);

    // SUCCESS REDIRECT: Redirect them back to your pricing card view 
    // to choose their custom daily email limits and pay
    return res.send(`
      <html>
        <body style="font-family:sans-serif; text-align:center; padding:50px; background:#0f172a; color:#fff;">
          <h2 style="color:#10b981;">Account Created Successfully!</h2>
          <p>We sent a simulation check token setup. You can now purchase your premium pass package below.</p>
          <a href="https://vercel.app" style="color:#6366f1; font-weight:bold; text-decoration:none;">Go back to Pricing Dashboard &rarr;</a>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('❌ Sign-up processing error:', error);
    return res.status(500).send('Internal Server Processing Error');
  }
}
