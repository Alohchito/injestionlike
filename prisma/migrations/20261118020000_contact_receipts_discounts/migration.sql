BEGIN;

CREATE TABLE IF NOT EXISTS public.plan_term_discounts (
  duration_months integer PRIMARY KEY CHECK (duration_months IN (1, 3, 6, 12)),
  discount_percent smallint NOT NULL CHECK (discount_percent IN (0, 5, 10, 15)),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.plan_term_discounts (duration_months, discount_percent)
VALUES (1, 0), (3, 5), (6, 10), (12, 15)
ON CONFLICT (duration_months) DO UPDATE
SET discount_percent = EXCLUDED.discount_percent, updated_at = now();

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS base_amount_usd numeric(12, 2),
  ADD COLUMN IF NOT EXISTS discount_percent smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount_usd numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS country_name text,
  ADD COLUMN IF NOT EXISTS receipt_file_name text,
  ADD COLUMN IF NOT EXISTS receipt_content_type text,
  ADD COLUMN IF NOT EXISTS receipt_size integer,
  ADD COLUMN IF NOT EXISTS receipt_chunk_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS receipt_notified_at timestamptz;

UPDATE public.pending_orders
SET base_amount_usd = amount_usd
WHERE base_amount_usd IS NULL;

ALTER TABLE public.pending_orders
  ALTER COLUMN base_amount_usd SET NOT NULL,
  ALTER COLUMN city DROP NOT NULL;

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_status_check;

ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_orders_status_check
  CHECK (status IN (
    'PENDING',
    'PENDING_INSTRUCTIONS',
    'RECEIPT_UPLOADING',
    'RECEIPT_SUBMITTED',
    'PAID',
    'CODE_SENDING',
    'CODE_SENT',
    'FULFILLED',
    'CANCELLED'
  ));

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_discount_percent_check,
  DROP CONSTRAINT IF EXISTS pending_orders_receipt_metadata_check;

ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_orders_discount_percent_check
  CHECK (discount_percent IN (0, 5, 10, 15)),
  ADD CONSTRAINT pending_orders_receipt_metadata_check
  CHECK (
    (receipt_size IS NULL AND receipt_chunk_count = 0)
    OR
    (receipt_size BETWEEN 1 AND 5242880
      AND receipt_chunk_count BETWEEN 1 AND 5
      AND receipt_file_name IS NOT NULL
      AND receipt_content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
  );

CREATE TABLE IF NOT EXISTS public.pending_order_receipt_chunks (
  order_id    text NOT NULL
              REFERENCES public.pending_orders(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 4),
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, chunk_index),
  CHECK (octet_length(data) BETWEEN 1 AND 1048576)
);

CREATE TABLE IF NOT EXISTS public.contact_submissions (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            text NOT NULL,
  email           text NOT NULL,
  country_code    varchar(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  country_name    text NOT NULL,
  city            text,
  subject         text NOT NULL,
  message         text NOT NULL,
  status          text NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('NEW', 'REPLIED', 'CLOSED')),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  admin_notified_at timestamptz
);

CREATE INDEX IF NOT EXISTS contact_submissions_submitted_idx
  ON public.contact_submissions (submitted_at DESC);

ALTER TABLE public.pending_order_receipt_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_term_discounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_term_discounts_public_read ON public.plan_term_discounts;
CREATE POLICY plan_term_discounts_public_read
  ON public.plan_term_discounts FOR SELECT
  TO anon, authenticated
  USING (true);

COMMIT;
