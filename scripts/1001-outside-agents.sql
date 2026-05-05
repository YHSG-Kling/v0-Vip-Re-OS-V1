-- ===========================================================================
-- 1001-outside-agents.sql
-- outside_agents — directory of REALTORS® and other licensed agents from
-- OTHER brokerages that we interact with (cooperating buyer/listing agents,
-- referring agents, etc.). They are NOT contacts in the CRM sense — they are
-- a distinct entity. They can be linked to contacts (e.g., "this buyer's
-- representing agent is Bob from XYZ Realty") via outside_agent_contact_links.
--
-- APPLIED VIA: supabase apply_migration "outside_agents_for_cooperating_agents"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.outside_agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  first_name        text,
  last_name         text,
  full_name         text,
  email             text,
  phone             text,
  phone_digits      text,
  license_number    text,
  license_state     text,
  outside_brokerage_name  text,
  mls_agent_id      text,
  city              text,
  state             text,
  zip_code          text,
  notes             text,
  source            text,           -- 'inbound_call' | 'manual_add' | 'mls_sync'
  added_by_user_id  uuid,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outside_agents_brokerage ON public.outside_agents(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_outside_agents_phone_digits ON public.outside_agents(phone_digits) WHERE phone_digits IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outside_agents_email ON public.outside_agents(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outside_agents_license ON public.outside_agents(license_number) WHERE license_number IS NOT NULL;

ALTER TABLE public.outside_agents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.outside_agent_contact_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outside_agent_id  uuid NOT NULL REFERENCES public.outside_agents(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id      uuid REFERENCES public.brokerages(id),
  link_role         text NOT NULL,     -- 'cooperating_buyer_agent' | 'cooperating_listing_agent' | 'referring_agent' | 'other'
  transaction_id    uuid,
  listing_id        uuid,
  created_by_user_id uuid,
  created_at        timestamptz DEFAULT now(),
  UNIQUE (outside_agent_id, contact_id, link_role)
);

CREATE INDEX IF NOT EXISTS idx_outside_agent_links_contact ON public.outside_agent_contact_links(contact_id);
CREATE INDEX IF NOT EXISTS idx_outside_agent_links_agent ON public.outside_agent_contact_links(outside_agent_id);

ALTER TABLE public.outside_agent_contact_links ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_outside_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_outside_agents_updated_at ON public.outside_agents;
CREATE TRIGGER trg_outside_agents_updated_at
  BEFORE UPDATE ON public.outside_agents
  FOR EACH ROW EXECUTE FUNCTION public.update_outside_agents_updated_at();
