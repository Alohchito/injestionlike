const { PrismaClient } = require('@prisma/client');
const { parseRequestBody } = require('../utils/request-body');
const { sendEmail } = require('../utils/email');

const prisma = new PrismaClient();
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const countryPattern = /^[A-Z]{2}$/;

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
  const countryCode = typeof body.countryCode === 'string'
    ? body.countryCode.trim().toUpperCase()
    : '';
  const countryName = typeof body.countryName === 'string' ? body.countryName.trim() : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (
    name.length < 2 || name.length > 160 ||
    !emailPattern.test(email) || email.length > 254 ||
    !countryPattern.test(countryCode) || !countryName || countryName.length > 100 ||
    city.length > 120 ||
    !subject || subject.length > 200 || /[\r\n]/.test(subject) ||
    message.length < 5 || message.length > 5000
  ) {
    return res.status(400).json({
      error: 'Please enter a valid name, email, country, subject, and message.',
    });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || !emailPattern.test(adminEmail) ||
      !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return res.status(503).json({ error: 'The contact form is temporarily unavailable.' });
  }

  try {
    const submissions = await prisma.$queryRaw`
      INSERT INTO public.contact_submissions (
        name, email, country_code, country_name, city, subject, message
      ) VALUES (
        ${name}, ${email}, ${countryCode}, ${countryName}, ${city || null},
        ${subject}, ${message}
      )
      RETURNING id, submitted_at AS "submittedAt"
    `;
    const submission = submissions[0];
    try {
      await sendEmail({
        to: adminEmail,
        subject: `Contact form: ${subject}`,
        text: [
          `Submission ID: ${submission.id}`,
          `From: ${name}`,
          `Reply email: ${email}`,
          `Location: ${city || 'Not specified'}, ${countryName} (${countryCode})`,
          `Subject: ${subject}`,
          '',
          message,
        ].join('\n'),
      });
      await prisma.$executeRaw`
        UPDATE public.contact_submissions
        SET admin_notified_at = now() WHERE id = ${submission.id}
      `;
    } catch (error) {
      console.error('Contact message delivery failed:', {
        submissionId: submission.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json({
        error: 'Your message was saved, but the team notification could not be sent. Please try again later.',
        submissionSaved: true,
        submissionId: submission.id,
      });
    }

    return res.status(201).json({
      message: 'Your message has been received. Our team will reply to the email address you provided.',
    });
  } catch (error) {
    console.error('Contact submission failed:', {
      code: error && error.code,
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: 'Your message could not be saved.' });
  }
};
