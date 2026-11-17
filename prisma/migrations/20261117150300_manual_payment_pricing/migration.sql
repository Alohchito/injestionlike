BEGIN;

ALTER TABLE public."User"
  ADD COLUMN IF NOT EXISTS "emailVerificationSentAt" timestamptz(6);

CREATE TABLE IF NOT EXISTS public.plan_tiers (
  tier_number       smallint PRIMARY KEY CHECK (tier_number BETWEEN 1 AND 10),
  daily_limit       integer NOT NULL UNIQUE
                    CHECK (daily_limit BETWEEN 1000 AND 10000 AND daily_limit % 1000 = 0),
  per_send_limit    integer NOT NULL
                    CHECK (per_send_limit = daily_limit / 10),
  monthly_price_usd numeric(8, 2) NOT NULL CHECK (monthly_price_usd >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.plan_tiers (tier_number, daily_limit, per_send_limit, monthly_price_usd)
VALUES
  (1,  1000,  100, 10.00),
  (2,  2000,  200, 18.00),
  (3,  3000,  300, 25.00),
  (4,  4000,  400, 32.00),
  (5,  5000,  500, 40.00),
  (6,  6000,  600, 48.00),
  (7,  7000,  700, 55.00),
  (8,  8000,  800, 62.00),
  (9,  9000,  900, 70.00),
  (10, 10000, 1000, 75.00)
ON CONFLICT (tier_number) DO UPDATE
SET daily_limit = EXCLUDED.daily_limit,
    per_send_limit = EXCLUDED.per_send_limit,
    monthly_price_usd = EXCLUDED.monthly_price_usd,
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id      text PRIMARY KEY
               REFERENCES public."User"(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'USER'
               CHECK (role IN ('USER', 'ADMIN')),
  country_code varchar(2)
               CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  region       text,
  city         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.profiles (user_id)
SELECT id FROM public."User"
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.payment_agents (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  country_code      varchar(2)
                    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  region            text,
  city              text,
  is_fallback       boolean NOT NULL DEFAULT false,
  payment_method    text NOT NULL
                    CHECK (payment_method IN (
                      'MOBILE_MONEY',
                      'BANK_TRANSFER',
                      'WESTERN_UNION',
                      'MONEYGRAM',
                      'INTERNATIONAL_WIRE',
                      'IN_PERSON_CASH',
                      'OTHER'
                    )),
  recipient_name    text,
  account_reference text,
  contact_phone     text,
  whatsapp          text,
  instructions      text NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  priority          integer NOT NULL DEFAULT 100,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (is_fallback AND country_code IS NULL)
    OR
    (NOT is_fallback AND country_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS payment_agents_match_idx
  ON public.payment_agents (country_code, is_active, priority);

CREATE INDEX IF NOT EXISTS payment_agents_fallback_idx
  ON public.payment_agents (is_fallback, is_active, priority);

CREATE TABLE IF NOT EXISTS public.pending_orders (
  id                            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                       text NOT NULL
                                REFERENCES public."User"(id) ON DELETE CASCADE,
  daily_limit                   integer NOT NULL
                                REFERENCES public.plan_tiers(daily_limit),
  duration_months               integer NOT NULL
                                CHECK (duration_months IN (1, 3, 6, 12)),
  amount_usd                    numeric(12, 2),
  country_code                  varchar(2) NOT NULL
                                CHECK (country_code ~ '^[A-Z]{2}$'),
  region                        text,
  city                          text NOT NULL,
  payment_method                text NOT NULL
                                CHECK (payment_method IN (
                                  'MOBILE_MONEY',
                                  'BANK_TRANSFER',
                                  'WESTERN_UNION',
                                  'MONEYGRAM',
                                  'INTERNATIONAL_WIRE',
                                  'IN_PERSON_CASH',
                                  'OTHER'
                                )),
  payment_agent_id              text
                                REFERENCES public.payment_agents(id)
                                ON DELETE SET NULL,
  payment_instructions_snapshot jsonb,
  status                        text NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN (
                                  'PENDING',
                                  'PAID',
                                  'FULFILLED',
                                  'CANCELLED'
                                )),
  admin_notes                   text,
  admin_notified_at             timestamptz,
  requested_at                  timestamptz NOT NULL DEFAULT now(),
  paid_at                       timestamptz,
  fulfilled_at                  timestamptz,
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_orders_status_requested_idx
  ON public.pending_orders (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS pending_orders_user_requested_idx
  ON public.pending_orders (user_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.activation_codes (
  id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code_hash           text NOT NULL UNIQUE,
  code_prefix         text NOT NULL,
  daily_limit         integer NOT NULL
                      REFERENCES public.plan_tiers(daily_limit),
  duration_months     integer NOT NULL
                      CHECK (duration_months IN (1, 3, 6, 12)),
  amount_usd          numeric(12, 2),
  status              text NOT NULL DEFAULT 'UNUSED'
                      CHECK (status IN ('UNUSED', 'ACTIVE', 'EXPIRED', 'REVOKED')),
  assigned_to_user_id text
                      REFERENCES public."User"(id) ON DELETE SET NULL,
  redeemed_by_user_id text
                      REFERENCES public."User"(id) ON DELETE SET NULL,
  pending_order_id    text UNIQUE
                      REFERENCES public.pending_orders(id) ON DELETE SET NULL,
  subscription_id     text UNIQUE
                      REFERENCES public."Subscription"(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  redeemed_at         timestamptz,
  starts_at           timestamptz,
  expires_at           timestamptz
);

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS amount_usd numeric(12, 2);

UPDATE public.pending_orders o
SET amount_usd = t.monthly_price_usd * o.duration_months
FROM public.plan_tiers t
WHERE o.daily_limit = t.daily_limit AND o.amount_usd IS NULL;

ALTER TABLE public.pending_orders
  ALTER COLUMN amount_usd SET NOT NULL;

ALTER TABLE public.activation_codes
  ADD COLUMN IF NOT EXISTS amount_usd numeric(12, 2);

UPDATE public.activation_codes c
SET amount_usd = t.monthly_price_usd * c.duration_months
FROM public.plan_tiers t
WHERE c.daily_limit = t.daily_limit AND c.amount_usd IS NULL;

ALTER TABLE public.activation_codes
  ALTER COLUMN amount_usd SET NOT NULL;

CREATE INDEX IF NOT EXISTS activation_codes_status_expiry_idx
  ON public.activation_codes (status, expires_at);

CREATE INDEX IF NOT EXISTS activation_codes_assigned_user_idx
  ON public.activation_codes (assigned_to_user_id);

CREATE TABLE IF NOT EXISTS public.blocked_senders (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  sender_user_id  text NOT NULL
                  REFERENCES public."User"(id) ON DELETE CASCADE,
  sender_email    text NOT NULL,
  recipient_email text NOT NULL,
  reason          text NOT NULL DEFAULT 'UNSUBSCRIBED'
                  CHECK (reason IN ('UNSUBSCRIBED', 'COMPLAINT', 'ADMINISTRATIVE')),
  source          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_email = lower(btrim(sender_email))),
  CHECK (recipient_email = lower(btrim(recipient_email))),
  UNIQUE (sender_user_id, sender_email, recipient_email)
);

CREATE INDEX IF NOT EXISTS blocked_senders_lookup_idx
  ON public.blocked_senders (sender_user_id, sender_email);

ALTER TABLE public.plan_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_senders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_tiers_public_read ON public.plan_tiers;

CREATE POLICY plan_tiers_public_read
  ON public.plan_tiers FOR SELECT
  TO anon, authenticated
  USING (true);

COMMIT;

-- Grant ADMIN only to an account you control, after verifying the user id:
-- UPDATE public.profiles SET role = 'ADMIN' WHERE user_id = '<verified User.id>';
--
-- The remaining tables intentionally have no browser-facing RLS policies.
-- Access them only through authenticated server routes using the server-side
-- database connection. Do not expose activation-code hashes or payment-agent
-- management endpoints to anon/authenticated clients.
