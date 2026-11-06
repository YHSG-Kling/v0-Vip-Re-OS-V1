-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150EFG ──
--
-- C35 — THE ONE RAWDATA PRODUCER CONTRACT (wave 150, lane 150EFG; directive lane 150F).
--
-- The producer is lib/kernel/scraping.ts ingestRawSourceBatch (the only raw_scraped_leads writer in app/ lib/
-- workflows/ apart from the deal-room demo seed). It now builds a RawData envelope for every record
-- (lib/lead-pipeline/raw-record-types.ts buildRawDataEnvelope) and writes it verbatim at
-- normalized_preview.rawdata AND as the first-class columns below. Until this file is applied the producer
-- detects the absent columns (PGRST204 naming one of them), writes the row the legacy way, keeps the envelope in
-- the jsonb, and COUNTS it (IngestBatchResult.envelope_columns_absent) — so applying this is what turns the
-- replay guard on.
--
-- Columns (all nullable — pre-m961 rows carry none of them; the reader falls back to normalized_preview.rawdata):
--   subject_kind        text  CHECK (one vocabulary with RAWDATA_SUBJECT_KINDS)
--   idempotency_key     text  scope-qualified ("t:<brokerage>|<source>|…" or "p|<source>|…") — UNIQUE (partial)
--   source_rights       text  CHECK (one vocabulary with RAWDATA_SOURCE_RIGHTS, lib/lead-pipeline/source-intent-map.ts)
--   source_licence      text  the NAME of the governing terms (never a claim the terms were reviewed)
--   signal_at           timestamptz  the payload's own date (null = undated)
--   observed_at         timestamptz  the producer's clock
--   ttl_expires_at      timestamptz  RAWDATA_TTL_DAYS per subject kind from the later-known of the two
--   external_ids        jsonb  source_record_id / event_id / identity_keys (APN, address, entity, household, person)
--   proof_urls          text[]
--   producer_actor_type text  CHECK (one vocabulary with RAWDATA_ACTOR_TYPES)
--   producer_actor_id   text
--   producer_version    text  ("rawdata-c35@1")
--   evidence            jsonb  behaviour type, intent signals, ownership verdict, caller-stated evidence
-- (cost rides the existing raw_scraped_leads.cost_per_record — not duplicated.)

ALTER TABLE public.raw_scraped_leads
  ADD COLUMN IF NOT EXISTS subject_kind        text,
  ADD COLUMN IF NOT EXISTS idempotency_key     text,
  ADD COLUMN IF NOT EXISTS source_rights       text,
  ADD COLUMN IF NOT EXISTS source_licence      text,
  ADD COLUMN IF NOT EXISTS signal_at           timestamptz,
  ADD COLUMN IF NOT EXISTS observed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS ttl_expires_at      timestamptz,
  ADD COLUMN IF NOT EXISTS external_ids        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS proof_urls          text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS producer_actor_type text,
  ADD COLUMN IF NOT EXISTS producer_actor_id   text,
  ADD COLUMN IF NOT EXISTS producer_version    text,
  ADD COLUMN IF NOT EXISTS evidence            jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.raw_scraped_leads DROP CONSTRAINT IF EXISTS raw_scraped_leads_subject_kind_check;
ALTER TABLE public.raw_scraped_leads ADD CONSTRAINT raw_scraped_leads_subject_kind_check CHECK (
  subject_kind IS NULL OR subject_kind IN (
    'person', 'owner', 'property', 'entity_trust_estate', 'household', 'business',
    'market', 'anonymous_question', 'job_civic_event', 'listing', 'signal'
  )
);

ALTER TABLE public.raw_scraped_leads DROP CONSTRAINT IF EXISTS raw_scraped_leads_source_rights_check;
ALTER TABLE public.raw_scraped_leads ADD CONSTRAINT raw_scraped_leads_source_rights_check CHECK (
  -- 'first_party_consented' and 'unknown' are in the TS vocabulary only to be REFUSED by the producer
  -- (rawDataEnvelopeProblem): a consented submission is a Contact (C8 captureContact) and an unknown basis is never written.
  source_rights IS NULL OR source_rights IN ('first_party_observed', 'licensed_vendor', 'public_record', 'public_web')
);

ALTER TABLE public.raw_scraped_leads DROP CONSTRAINT IF EXISTS raw_scraped_leads_producer_actor_type_check;
ALTER TABLE public.raw_scraped_leads ADD CONSTRAINT raw_scraped_leads_producer_actor_type_check CHECK (
  producer_actor_type IS NULL OR producer_actor_type IN (
    'cron', 'webhook', 'csv_import', 'actor', 'sdk_mcp', 'manual', 'research', 'vendor_event', 'manager_action'
  )
);

-- THE REPLAY GUARD. The key already carries its scope (tenant or platform), so one UNIQUE on the key is
-- "one observation per owner": two tenants observing the same property hold two rows; ten replays hold one.
-- The producer reads 23505 naming this index as a REPLAY (IngestBatchResult.replayed).
CREATE UNIQUE INDEX IF NOT EXISTS raw_scraped_leads_idempotency_key_uniq
  ON public.raw_scraped_leads (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_subject_kind ON public.raw_scraped_leads (subject_kind) WHERE subject_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_ttl ON public.raw_scraped_leads (ttl_expires_at) WHERE ttl_expires_at IS NOT NULL;

COMMENT ON COLUMN public.raw_scraped_leads.idempotency_key IS
  'C35 (wave 150, lane 150EFG): scope-qualified observation key (t:<brokerage>|<source>|evt:/rec:/dig:…). Written by lib/kernel/scraping.ts ingestRawSourceBatch; UNIQUE — ten replays are one row.';
COMMENT ON COLUMN public.raw_scraped_leads.subject_kind IS
  'C35: what the observation is about. Only person / owner / household may walk to the Lead door (lib/lead-pipeline/canonical-lead-eligibility.ts subjectKindLeadProblem).';

-- OWNER SQL-EDITOR (O-item, not run here — DROP INDEX is owner-only per the wave header):
--   The live UNIQUE raw_scraped_leads_source_record_id_key ON (source, source_record_id) is GLOBAL, i.e. CROSS-TENANT:
--   a second tenant that lawfully observes the same listing / property under the same source id is refused 23505 and
--   never gets its own observation (canary 3, "same property may be lawfully researched per tenant"). Once this file is
--   applied the scope-qualified key above is the replay guard, and the global index can go:
--     DROP INDEX IF EXISTS public.raw_scraped_leads_source_record_id_key;
--   Verified 2026-11-06: raw_scraped_leads holds 0 rows live, so the drop loses nothing.
