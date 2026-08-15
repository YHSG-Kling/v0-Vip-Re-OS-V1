-- ===========================================================================
-- 1000-isa-pipeline-phase3-foundations.sql
-- ISA Pipeline Phase 3 Foundations
-- Adds source_origin flag, platform distribution + suppression tables,
-- VAPI multi-tenant phone routing, voice mode on identity profiles,
-- long-term nurture columns, and signal re-activation tracking.
--
-- APPLIED VIA: supabase apply_migration "isa_pipeline_phase3_foundations"
-- ===========================================================================

-- 1. raw_scraped_leads + leads: source origin ('platform' | 'brokerage')
ALTER TABLE public.raw_scraped_leads
  ADD COLUMN IF NOT EXISTS source_origin text DEFAULT 'brokerage'
    CHECK (source_origin IN ('platform','brokerage'));

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source_origin text DEFAULT 'brokerage'
    CHECK (source_origin IN ('platform','brokerage'));

-- 2. leads: Engine 1 distribution columns
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS distribution_brokerage_id uuid REFERENCES public.brokerages(id),
  ADD COLUMN IF NOT EXISTS distributed_at timestamptz,
  ADD COLUMN IF NOT EXISTS long_term_nurture_until timestamptz,
  ADD COLUMN IF NOT EXISTS long_term_nurture_reason text,
  ADD COLUMN IF NOT EXISTS long_term_nurture_started_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_leads_distribution_brokerage
  ON public.leads(distribution_brokerage_id);
CREATE INDEX IF NOT EXISTS idx_leads_long_term_nurture
  ON public.leads(long_term_nurture_until)
  WHERE long_term_nurture_until IS NOT NULL;

-- 3. ai_identity_profiles: voice mode + provider voice IDs
ALTER TABLE public.ai_identity_profiles
  ADD COLUMN IF NOT EXISTS voice_mode text DEFAULT 'clone'
    CHECK (voice_mode IN ('clone','front_office','assistant')),
  ADD COLUMN IF NOT EXISTS elevenlabs_voice_id text,
  ADD COLUMN IF NOT EXISTS vapi_assistant_id text,
  ADD COLUMN IF NOT EXISTS voice_provider text DEFAULT 'elevenlabs'
    CHECK (voice_provider IN ('elevenlabs','vapi'));

-- 4. platform_suppression_list (cross-tenant DNC)
CREATE TABLE IF NOT EXISTS public.platform_suppression_list (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_digits  text,
  email         text,
  reason        text NOT NULL CHECK (reason IN (
    'explicit_opt_out','tcpa_violation','federal_dnc',
    'spam_complaint','litigator','manual_admin'
  )),
  source_lead_id    uuid,
  source_contact_id uuid,
  source_brokerage_id uuid,
  added_by_user_id  uuid,
  notes         text,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suppression_phone ON public.platform_suppression_list(phone_digits) WHERE phone_digits IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppression_email ON public.platform_suppression_list(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression_phone ON public.platform_suppression_list(phone_digits) WHERE phone_digits IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression_email ON public.platform_suppression_list(email) WHERE email IS NOT NULL;

ALTER TABLE public.platform_suppression_list ENABLE ROW LEVEL SECURITY;

-- 5. platform_lead_distributions (Engine 1 round-robin tracking)
CREATE TABLE IF NOT EXISTS public.platform_lead_distributions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zip_code           text NOT NULL,
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  lead_id            uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  raw_lead_id        uuid,
  distributed_at     timestamptz DEFAULT now(),
  rotation_position  int,
  source_family      text,
  motivation_type    text,
  urgency_level      text
);

CREATE INDEX IF NOT EXISTS idx_platform_dist_zip_brokerage
  ON public.platform_lead_distributions(zip_code, brokerage_id, distributed_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_dist_brokerage
  ON public.platform_lead_distributions(brokerage_id, distributed_at DESC);

ALTER TABLE public.platform_lead_distributions ENABLE ROW LEVEL SECURITY;

-- 6. subscriber_service_areas (which zips each tenant serves)
CREATE TABLE IF NOT EXISTS public.subscriber_service_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  team_id       uuid,
  agent_user_id uuid,
  zip_code      text NOT NULL,
  city          text,
  state         text,
  is_primary    boolean DEFAULT false,
  joined_at     timestamptz DEFAULT now(),
  active        boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_areas_zip
  ON public.subscriber_service_areas(zip_code, active, joined_at);
CREATE INDEX IF NOT EXISTS idx_service_areas_brokerage
  ON public.subscriber_service_areas(brokerage_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_brokerage_zip
  ON public.subscriber_service_areas(brokerage_id, zip_code)
  WHERE agent_user_id IS NULL AND team_id IS NULL;

ALTER TABLE public.subscriber_service_areas ENABLE ROW LEVEL SECURITY;

-- 7. vapi_phone_numbers (multi-tenant phone routing + BYOC support)
CREATE TABLE IF NOT EXISTS public.vapi_phone_numbers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  team_id             uuid,
  agent_user_id       uuid,
  scope_type          text NOT NULL CHECK (scope_type IN ('platform','brokerage','team','agent')),
  vapi_phone_number_id text NOT NULL,
  phone_number        text NOT NULL,
  phone_digits        text,
  number_source       text DEFAULT 'vapi_native'
    CHECK (number_source IN ('vapi_native','ported','byoc_twilio','byoc_vonage','forwarded')),
  byoc_credential_id  text,
  forwarding_target   text,
  department          text,
  ivr_enabled         boolean DEFAULT false,
  ivr_menu            jsonb,
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vapi_numbers_brokerage
  ON public.vapi_phone_numbers(brokerage_id, is_active);
CREATE INDEX IF NOT EXISTS idx_vapi_numbers_agent
  ON public.vapi_phone_numbers(agent_user_id) WHERE agent_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vapi_numbers_phone_digits
  ON public.vapi_phone_numbers(phone_digits);

ALTER TABLE public.vapi_phone_numbers ENABLE ROW LEVEL SECURITY;

-- 8. signal_reactivations (track when long-term nurture leads come back)
CREATE TABLE IF NOT EXISTS public.signal_reactivations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id        uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id      uuid,
  signal_type       text NOT NULL,
  signal_strength   numeric,
  signal_data       jsonb,
  triggered_at      timestamptz DEFAULT now(),
  isa_reactivated   boolean DEFAULT false,
  isa_reactivated_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_signal_reactivations_lead ON public.signal_reactivations(lead_id);
CREATE INDEX IF NOT EXISTS idx_signal_reactivations_contact ON public.signal_reactivations(contact_id);
CREATE INDEX IF NOT EXISTS idx_signal_reactivations_triggered ON public.signal_reactivations(triggered_at DESC);

ALTER TABLE public.signal_reactivations ENABLE ROW LEVEL SECURITY;

-- 9. inbound_call_classifications (caller routing decisions)
CREATE TABLE IF NOT EXISTS public.inbound_call_classifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id     uuid,
  brokerage_id    uuid,
  caller_phone    text,
  caller_phone_digits text,
  classification  text NOT NULL CHECK (classification IN (
    'real_estate_buyer','real_estate_seller','real_estate_investor',
    'vendor','business_general','cooperating_agent','existing_contact','unknown'
  )),
  resulting_contact_id  uuid,
  resulting_vendor_id   uuid,
  ai_handled            boolean DEFAULT false,
  transferred_to_user_id uuid,
  transfer_reason       text,
  classified_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_class_phone
  ON public.inbound_call_classifications(caller_phone_digits);
CREATE INDEX IF NOT EXISTS idx_inbound_class_brokerage
  ON public.inbound_call_classifications(brokerage_id, classified_at DESC);

ALTER TABLE public.inbound_call_classifications ENABLE ROW LEVEL SECURITY;
