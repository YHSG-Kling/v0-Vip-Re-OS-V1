-- Kernel OS Universal Compliance Rail — Migration
-- Run: IF NOT EXISTS guards on every statement so it is safe to re-run.

-- ──────────────────────────────────────────────────────────────────────────────
-- leads: add missing TCPA columns
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS tcpa_consent_ip          text,
  ADD COLUMN IF NOT EXISTS tcpa_consent_user_agent  text;

-- ──────────────────────────────────────────────────────────────────────────────
-- contacts: add missing TCPA + unsubscribe columns
-- tcpa_consent_date already exists; add tcpa_consent_text / source
-- email_opt_out / sms_opt_out already exist; add explicit unsubscribed columns
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS tcpa_consent_at           timestamptz,
  ADD COLUMN IF NOT EXISTS tcpa_consent_text         text,
  ADD COLUMN IF NOT EXISTS tcpa_consent_source       text,
  ADD COLUMN IF NOT EXISTS tcpa_consent_ip           text,
  ADD COLUMN IF NOT EXISTS email_unsubscribed        boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_unsubscribed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS sms_unsubscribed          boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_unsubscribed_at       timestamptz;

-- Back-fill: if email_opt_out is true, treat as unsubscribed
UPDATE public.contacts
SET email_unsubscribed = true
WHERE email_opt_out = true AND email_unsubscribed IS DISTINCT FROM true;

UPDATE public.contacts
SET sms_unsubscribed = true
WHERE sms_opt_out = true AND sms_unsubscribed IS DISTINCT FROM true;

-- ──────────────────────────────────────────────────────────────────────────────
-- contact_consent_events: new table
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_consent_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       uuid REFERENCES public.contacts(contact_id) ON DELETE SET NULL,
  lead_id          uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  brokerage_id     uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id         uuid,
  consent_type     text NOT NULL,   -- 'tcpa' | 'email_unsubscribe' | 'sms_stop' | etc.
  consent_text     text NOT NULL,
  consent_source   text NOT NULL,   -- page path or 'sms_stop' | 'email_footer'
  consented        boolean NOT NULL,
  ip_address       text,
  user_agent       text,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE public.contact_consent_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'contact_consent_events'
    AND policyname = 'cce_brokerage_isolation'
  ) THEN
    CREATE POLICY cce_brokerage_isolation ON public.contact_consent_events
      USING (brokerage_id IN (
        SELECT brokerage_id FROM public.users WHERE id = auth.uid()
      ));
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- contact_suppression_list: new table
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_suppression_list (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES public.contacts(contact_id) ON DELETE SET NULL,
  email               text,
  phone               text,
  channel             text NOT NULL CHECK (channel IN ('email','sms','phone','mail')),
  suppression_reason  text NOT NULL,
  source              text NOT NULL,  -- 'email_footer' | 'sms_stop' | 'manual' | 'admin'
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS csl_email_idx   ON public.contact_suppression_list (brokerage_id, email);
CREATE INDEX IF NOT EXISTS csl_phone_idx   ON public.contact_suppression_list (brokerage_id, phone);
CREATE INDEX IF NOT EXISTS csl_contact_idx ON public.contact_suppression_list (brokerage_id, contact_id);

ALTER TABLE public.contact_suppression_list ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'contact_suppression_list'
    AND policyname = 'csl_brokerage_isolation'
  ) THEN
    CREATE POLICY csl_brokerage_isolation ON public.contact_suppression_list
      USING (brokerage_id IN (
        SELECT brokerage_id FROM public.users WHERE id = auth.uid()
      ));
  END IF;
END $$;
