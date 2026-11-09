const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('../utils/password');

const prisma = new PrismaClient();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const body = req.body;
  const email =
    body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).send('Please enter both an email and password.');
  }

  if (email.length > 254 || !emailPattern.test(email)) {
    return res.status(400).send('Please enter a valid email address.');
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).send('Password must be between 8 and 128 characters.');
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash },
      select: { email: true },
    });

    console.log(`New user registered: ${user.email}`);
    return res.status(201).send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;">
          <h2 style="color:#10b981;">Account Created Successfully</h2>
          <p>Your account is registered. Choose a plan to activate it.</p>
          <a href="/" style="color:#6366f1;font-weight:bold;text-decoration:none;">Go to the pricing page &rarr;</a>
        </body>
      </html>
    `);
  } catch (error) {
    if (error && error.code === 'P2002') {
      return res.status(409).send('An account with this email already exists. Please log in.');
    }

    console.error('Sign-up processing error:', error);
    return res.status(500).send('Account creation failed. Please try again later.');
  }
};
