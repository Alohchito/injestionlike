const { parseRequestBody } = require('../utils/request-body');
const { sendEmail } = require('../utils/email');

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = parseRequestBody(req.body, String(req.headers && req.headers['content-type'] || ''));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid contact form submission.' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (
    name.length < 2 || name.length > 160 ||
    !emailPattern.test(email) || email.length > 254 ||
    !subject || subject.length > 200 || /[\r\n]/.test(subject) ||
    message.length < 5 || message.length > 5000
  ) {
    return res.status(400).json({ error: 'Please enter a valid name, email, subject, and message.' });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || !emailPattern.test(adminEmail) ||
      !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return res.status(503).json({ error: 'The contact form is temporarily unavailable.' });
  }

  try {
    await sendEmail({
      to: adminEmail,
      subject: `Contact form: ${subject}`,
      text: [
        `From: ${name}`,
        `Reply email: ${email}`,
        `Subject: ${subject}`,
        '',
        message,
      ].join('\n'),
    });
    return res.status(200).json({ message: 'Your message has been received. Thank you for contacting us.' });
  } catch (error) {
    console.error('Contact message delivery failed:', {
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(502).json({ error: 'Your message could not be delivered. Please try again later.' });
  }
};
