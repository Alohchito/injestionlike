# Deployment and manual activation

## Database

The application uses Prisma and PostgreSQL. Set `DATABASE_URL` in local `.env`
and in every Vercel deployment environment. Keep the connection string secret;
do not commit it. The manual-payment migration creates the plan catalog,
profiles, pending orders, agents, activation codes, and sender-specific blocks.
The follow-up customer-payment migration adds submitted customer details and
saved admin payment-instruction templates. The contact-and-receipts migration
adds discounted term pricing, private contact submissions, and chunked receipt
storage. Apply all migrations before deploying the matching application code.
It was applied directly with `prisma db execute`; if you later use Prisma
Migrate, the SQL is safe to re-run and the migration must be recorded in the
Prisma migration history before `prisma migrate deploy` is used as the sole
deployment mechanism.

Generate Prisma Client and deploy:

```sh
npm run build
npx prisma migrate deploy
```

The account provided for initial admin access was not present when the
migration ran. Set `ADMIN_EMAIL` to `chitofelixnatobi@gmail.com` in Vercel and
local environment settings, then register that address through the app and
verify its email. Signup will create its server-controlled `ADMIN` profile.
For an already-registered account, after verifying the email run this SQL once
using a privileged database connection:

```sql
UPDATE public.profiles p
SET role = 'ADMIN', updated_at = now()
FROM public."User" u
WHERE p.user_id = u.id
  AND lower(u.email) = lower('chitofelixnatobi@gmail.com');
```

Never accept role changes from browser form data. Admin APIs authorize from the
database profile for every request.

## Email verification and admin alerts

Configure these Vercel variables before production signup:

- `SESSION_SECRET`: random value containing at least 32 bytes.
- `ACTIVATION_CODE_SECRET`: recommended separate random value containing at
  least 32 bytes; if absent, code hashes use `SESSION_SECRET`.
- `RESEND_API_KEY` and `EMAIL_FROM`: verified sender identity for email
  verification and optional admin notifications.
- `ADMIN_EMAIL`: administrator email for new-order alerts and first-signup
  bootstrap. Set to the address above.
- `ADMIN_ALERT_WEBHOOK_URL`: optional HTTPS endpoint for an additional order
  alert.

Verification codes expire after 15 minutes and are stored as HMAC hashes.
`TEST_MODE_VERIFICATION_CODE=true` may be enabled only outside production for
testing; it returns the code in the response and logs it. Do not enable it in
production. Admin order views poll for updates, and successful configured
email/webhook notifications are recorded on the order.

## Manual payment and activation

The site displays the ten USD monthly plan rates from `utils/pricing.js`.
Multi-month totals apply 5% off for 3 months, 10% off for 6 months, and 15%
off for 12 months; one month has no discount. The database catalog and term
discount table are seeded by migrations.

Customers must verify their account before they can submit a plan request.
They choose a tier and duration from the Contact Us page and submit their
registered email, country, optional city, preferred payment method/message, and
optional receipt. Payment requests require a verified account. Receipts are
stored in private database chunks, checked against their declared image/PDF
type and downloaded only through the protected `/admin` API. General contact
messages are retained in the administrator inbox. Agent contact details are
not exposed through the customer API or UI. The billing alert is sent to
`ADMIN_EMAIL`; admins use `/admin` to send customized payment instructions or
contact replies from `EMAIL_FROM`. Templates can be saved and reused from the
reply dialog.

Confirm payment only after funds are received. The administrator confirmation
action generates an order-bound single-use code and emails it to the
registered account address. The visible code is stored only as a keyed hash;
the admin screen offers a one-time copy backup immediately after delivery.
Customers redeem codes from the dashboard.

All non-pricing tables have RLS enabled without browser-facing policies. Keep
database access behind the app's authenticated server routes and never expose
database credentials in frontend code. The app uses its signed-cookie session,
not Supabase Auth; Supabase `auth.uid()` is not the application identity.

## Sending safety and rollout

The send API checks verified account/sender state, the mandatory recipient
consent confirmation, a per-send limit of 10% of the active daily plan, the
rolling 24-hour quota, and sender-specific recipient blocks. The
`/api/unsubscribe` endpoint records recipient-specific blocks from encrypted
opt-out tokens created by `utils/opt-out.js`. Any future outbound adapter must
attach a generated opt-out link to every forwarded campaign message and honor
the block before delivery. Send operations remain disabled until a trusted
outbound relay is configured with these links and atomic quota reservations.
Do not enable live sending until these paths have been tested end to end.

The public `/api/payment-agents` endpoint is disabled and returns no agent
information. Configure `RESEND_API_KEY`, `EMAIL_FROM` (a verified site sender,
for example `no-reply@your-verified-domain`), and `ADMIN_EMAIL` for payment
request notifications, payment-instruction replies, and the private `/contact`
form. The contact page displays no organization email, phone, or physical
address.

Terms in the UI describe the platform as a technical relay and put recipient
permission and legal compliance responsibilities on the sender. Review legal
wording for the jurisdictions where the service operates.

Online checkout and its payment webhook return `410 Gone`; do not configure
payment-provider webhooks. Deploy the site on the existing Vercel URL first,
test registration, verification email, pending order alerts, agent fallback,
paid-order code creation, code redemption, admin protections, quota checks,
and opt-out handling, then connect a custom domain and configure mail-domain
DNS (SPF, DKIM, and DMARC).
