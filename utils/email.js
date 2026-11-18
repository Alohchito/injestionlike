async function sendEmail({ to, subject, text, html, from, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  const sender = from || process.env.EMAIL_FROM;
  if (!apiKey || !sender) {
    throw new Error('Configure RESEND_API_KEY and EMAIL_FROM to send email.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: sender,
      to,
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Email delivery provider rejected the message (status ${response.status}).`);
  }
}

module.exports = { sendEmail };
