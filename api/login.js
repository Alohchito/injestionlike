const { PrismaClient } = require('@prisma/client');
const { verifyPassword } = require('../utils/password');

const prisma = new PrismaClient();

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

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        email: true,
        status: true,
        passwordHash: true,
        subscriptions: {
          where: {
            status: 'ACTIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { emailsPer24Hours: true },
        },
      },
    });

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).send('Invalid email or password.');
    }

    if (user.status !== 'ACTIVE') {
      return res.send(`
        <html>
          <body style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;">
            <h2 style="color:#6366f1;">Welcome Back</h2>
            <p>Your account is registered but is not active yet.</p>
            <a href="/" style="color:#10b981;font-weight:bold;text-decoration:none;">Choose a plan &rarr;</a>
          </body>
        </html>
      `);
    }

    const activeSubscription = user.subscriptions[0];
    const planMessage = activeSubscription
      ? `<p>Your daily sending limit is <strong>${activeSubscription.emailsPer24Hours} emails</strong>.</p>`
      : '<p>Your account is active, but there is no active plan.</p>';

    return res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:50px;background:#0f172a;color:#fff;">
          <h2 style="color:#10b981;">Account Active</h2>
          <p>Logged in as: <strong>${escapeHtml(user.email)}</strong></p>
          ${planMessage}
          <a href="/" style="color:#6366f1;font-weight:bold;text-decoration:none;">Return to the pricing page &rarr;</a>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Login processing error:', error);
    return res.status(500).send('Login failed. Please try again later.');
  }
};

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}
