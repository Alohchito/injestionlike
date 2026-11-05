function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character];
  });
}

function getSafePortalUrl(portalUrl: string): string {
  const parsedUrl = new URL(portalUrl);
  const isLocalDevelopment =
    parsedUrl.protocol === "http:" &&
    (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");

  if (
    (parsedUrl.protocol !== "https:" && !isLocalDevelopment) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error("Portal URL must use HTTPS.");
  }

  return escapeHtml(parsedUrl.toString());
}

export function getAdminActivationEmailHtml(
  activationCode: string,
  portalUrl: string,
): string {
  if (!/^\d{6}$/.test(activationCode)) {
    throw new Error("Activation code must contain exactly six digits.");
  }

  const safeActivationCode = escapeHtml(activationCode);
  const safePortalUrl = getSafePortalUrl(portalUrl);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Verified - Secure Activation Code</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f1f5f9; margin: 0; padding: 40px 20px; }
        .email-container { max-width: 550px; margin: 0 auto; background-color: #1e293b; border-radius: 16px; border: 1px solid #334155; padding: 40px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3); }
        .status-badge { display: inline-block; background-color: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; color: #10b981; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; padding: 6px 16px; border-radius: 9999px; margin-bottom: 24px; }
        h1 { color: #ffffff; margin: 0 0 16px 0; font-size: 22px; font-weight: 800; letter-spacing: -0.025em; }
        p { color: #cbd5e1; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0; }
        .code-wrapper { text-align: center; margin: 32px 0; background-color: #0f172a; border: 1px dashed #6366f1; border-radius: 12px; padding: 24px; }
        .code-label { display: block; color: #94a3b8; font-size: 12px; text-transform: uppercase; font-weight: bold; letter-spacing: 1px; margin-bottom: 8px; }
        .activation-code { color: #38bdf8; font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 900; letter-spacing: 8px; margin: 0; padding-left: 8px; }
        .btn-wrapper { text-align: center; margin: 32px 0 20px 0; }
        .action-button { background: linear-gradient(135deg, #6366f1, #4f46e5); color: #ffffff !important; padding: 14px 32px; font-weight: bold; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 15px; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3); }
        .warning-text { font-size: 13px; color: #94a3b8; border-left: 3px solid #f59e0b; padding-left: 12px; margin: 24px 0; }
        .footer { text-align: center; margin-top: 40px; font-size: 11px; color: #64748b; border-top: 1px solid #334155; padding-top: 24px; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="email-container">
        <div class="status-badge">Payment Confirmed</div>
        <h1>Your Account Access is Approved</h1>
        
        <p>Hello,</p>
        <p>Our administration team has successfully reviewed your payment transaction and manually verified your account deposit. Your global premium bulk email distribution node is completely provisioned and ready for deployment.</p>
        
        <p>To safely unlock your delivery quota limits and activate your broadcasting dashboard, copy the highly secure cryptographic code below and enter it inside your client portal:</p>
        
        <div class="code-wrapper">
          <span class="code-label">Secure Activation Code</span>
          <h2 class="activation-code">${safeActivationCode}</h2>
        </div>

        <div class="warning-text">
          <strong>Security Notice:</strong> This single-use code was issued for your registered email address and expires in exactly 24 hours. For security compliance, never share this code with anyone.
        </div>

        <div class="btn-wrapper">
          <a href="${safePortalUrl}" class="action-button">Enter Activation Code</a>
        </div>

        <div class="footer">
          This is an official transaction status alert. Unverified or inactive platform configurations are systematically dropped after 3 consecutive months under our standard global terms of service. Payments are non-refundable.
        </div>
      </div>
    </body>
    </html>
  `;
}
