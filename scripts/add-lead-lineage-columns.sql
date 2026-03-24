-- Lead Lineage OS Migration
-- Adds missing columns to leads and raw_scraped_leads for full pipeline tracking

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS raw_record_id uuid,
  ADD COLUMN IF NOT EXISTS enrichment_provider text,
  ADD COLUMN IF NOT EXISTS dedupe_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS duplicate_of_lead_id uuid,
  ADD COLUMN IF NOT EXISTS duplicate_of_contact_id uuid,
  ADD COLUMN IF NOT EXISTS minimum_viable_for_isa boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS mailing_address text,
  ADD COLUMN IF NOT EXISTS mailing_city text,
  ADD COLUMN IF NOT EXISTS mailing_state text,
  ADD COLUMN IF NOT EXISTS mailing_zip text,
  ADD COLUMN IF NOT EXISTS mailing_address_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS mailing_address_source text,
  ADD COLUMN IF NOT EXISTS tcpa_consent boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS tcpa_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS tcpa_consent_source text,
  ADD COLUMN IF NOT EXISTS tcpa_consent_text text,
  ADD COLUMN IF NOT EXISTS ai_isa_owner boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS handed_to_agent_at timestamptz,
  ADD COLUMN IF NOT EXISTS converted_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'new';

-- Raw scraped leads additional columns for dedupe + enrichment tracking
ALTER TABLE public.raw_scraped_leads
  ADD COLUMN IF NOT EXISTS dedupe_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz,
  ADD COLUMN IF NOT EXISTS mailing_address text,
  ADD COLUMN IF NOT EXISTS mailing_city text,
  ADD COLUMN IF NOT EXISTS mailing_state text,
  ADD COLUMN IF NOT EXISTS mailing_zip text,
  ADD COLUMN IF NOT EXISTS mailing_address_verified boolean DEFAULT false;

-- Back-fill minimum_viable_for_isa based on whether email exists
UPDATE public.leads
SET minimum_viable_for_isa = true
WHERE email IS NOT NULL AND email <> '' AND minimum_viable_for_isa = false;

-- Back-fill dedupe_status to 'complete' for leads that predate this migration
-- (they were implicitly deduped on entry)
UPDATE public.leads
SET dedupe_status = 'complete'
WHERE dedupe_status = 'pending' AND created_at < now() - interval '1 hour';
