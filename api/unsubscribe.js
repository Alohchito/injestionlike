const { PrismaClient } = require('@prisma/client');
const { parseRequestBody } = require('../utils/request-body');
const { readOptOutToken } = require('../utils/opt-out');

const prisma = new PrismaClient();
const confirmationPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><body style="font:16px system-ui;max-width:560px;margin:48px auto;padding:16px"><h1>Block this sender</h1><p>Confirm to stop messages from this specific sender address. This does not block the Injestionlike relay service.</p><form method="post" action="/api/unsubscribe"><input type="hidden" name="token" value="TOKEN_PLACEHOLDER"><button type="submit">Unsubscribe from this sender</button></form></body></html>`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).send('Method Not Allowed');
  }

  let token = req.method === 'GET' && req.query ? req.query.token : null;
  if (req.method === 'POST') {
    try {
      const body = parseRequestBody(req.body, String(req.headers && req.headers['content-type'] || ''));
      token = body.token;
    } catch (error) {
      return res.status(400).send('Invalid unsubscribe request.');
    }
  }

  let details;
  try {
    details = readOptOutToken(token);
  } catch (error) {
    return res.status(400).send('This unsubscribe link is invalid.');
  }

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(confirmationPage.replace('TOKEN_PLACEHOLDER', token));
  }

  try {
    await prisma.$executeRaw`
      INSERT INTO public.blocked_senders (
        sender_user_id, sender_email, recipient_email, reason, source
      ) VALUES (
        ${details.senderUserId}, ${details.senderEmail}, ${details.recipientEmail},
        'UNSUBSCRIBED', 'signed_email_opt_out'
      )
      ON CONFLICT (sender_user_id, sender_email, recipient_email) DO NOTHING
    `;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Unsubscribed</title><body style="font:16px system-ui;max-width:560px;margin:48px auto;padding:16px"><h1>You are unsubscribed</h1><p>You will no longer receive messages from this sender address.</p></body></html>',
    );
  } catch (error) {
    console.error('Recipient opt-out could not be saved:', {
      code: error && error.code,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).send('Your opt-out could not be recorded. Please try again later.');
  }
};
