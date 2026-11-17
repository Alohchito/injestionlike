BEGIN;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS customer_email text,
  ADD COLUMN IF NOT EXISTS phone_whatsapp text,
  ADD COLUMN IF NOT EXISTS additional_notes text;

UPDATE public.pending_orders o
SET customer_name = COALESCE(NULLIF(o.customer_name, ''), split_part(u.email, '@', 1)),
    customer_email = COALESCE(NULLIF(o.customer_email, ''), u.email),
    phone_whatsapp = COALESCE(o.phone_whatsapp, '')
FROM public."User" u
WHERE u.id = o.user_id;

ALTER TABLE public.pending_orders
  ALTER COLUMN customer_name SET NOT NULL,
  ALTER COLUMN customer_email SET NOT NULL,
  ALTER COLUMN phone_whatsapp SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.payment_instruction_templates (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        text NOT NULL UNIQUE,
  subject     text NOT NULL DEFAULT 'Your Injestionlike payment instructions',
  body        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_instruction_templates ENABLE ROW LEVEL SECURITY;

COMMIT;
