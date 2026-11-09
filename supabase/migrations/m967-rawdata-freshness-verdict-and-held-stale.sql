-- WRITTEN, NOT APPLIED (wave 151, lane 151C) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL
--
-- FRESHNESS PER SIGNAL TYPE + THE HOLD (wave 151, lane 151C).
--
-- Owner: "lead acquisitions should be checking how old the activity is because you don't want to bring in old and stale
-- data." The policy lives in lib/lead-pipeline/freshness.ts (evaluateFreshness — one policy per signal class, anchored on
-- the date that counts for that class). The ONE producer (lib/kernel/scraping.ts ingestRawSourceBatch) judges every record
-- before it exists and the pipeline (lib/lead-pipeline/pipeline-processor.ts processRawRecord) judges it again before any
-- enrichment spend. m961 already carries signal_at / observed_at / ttl_expires_at (checked first — not duplicated). What
-- was genuinely missing:
--
--   last_verified_at   timestamptz  the date a source most recently RE-CONFIRMED the observation. The producer stamps it
--                                   with observed_at on insert and BUMPS it when a replay (23505 on the C35 idempotency
--                                   key) re-delivers the same observation — the "date most recently verified" the owner-
--                                   record and investor-population policies age from (freshness.ts anchor last_verified_at).
--   freshness_verdict  text         the policy's verdict at the last judgement, queryable (the planner counts held rows per
--                                   source; the cockpit shows why a row is held). CHECK = lib/lead-pipeline/freshness.ts
--                                   FRESHNESS_VERDICTS (one vocabulary).
--   processing_status  'held_stale' the HOLD: the observation stays at its evidence level (an old deed is property history),
--                                   is never enriched or promoted on this signal, and error_message carries the reason.
--                                   CHECK regenerated from lib/lead-pipeline/processing-status.ts RAW_PROCESSING_STATUSES
--                                   (the one vocabulary; same values as live + 'held_stale').
--
-- Until this file is applied the producer detects the absent columns (PGRST204 / 42703 naming one of them), writes the row
-- without them, keeps the verdict in evidence.freshness (m961 jsonb) and COUNTS it (IngestBatchResult.freshness_columns_absent);
-- a held_stale write before apply is refused by the live CHECK and READ as a refusal by setStatus (never silent).
--
-- After apply: regenerate the schema caches (schema-snapshot / check-vocabularies) and add the mirror
--   { file: "lib/lead-pipeline/freshness.ts", constant: "FRESHNESS_VERDICTS", table: "raw_scraped_leads", column: "freshness_verdict", constraint: "raw_scraped_leads_freshness_verdict_check" }
-- to scripts/check-vocabulary-guard.ts MIRRORS (lane 151C notes, Outside-lane).

ALTER TABLE public.raw_scraped_leads
  ADD COLUMN IF NOT EXISTS last_verified_at  timestamptz,
  ADD COLUMN IF NOT EXISTS freshness_verdict text;

ALTER TABLE public.raw_scraped_leads DROP CONSTRAINT IF EXISTS raw_scraped_leads_freshness_verdict_check;
ALTER TABLE public.raw_scraped_leads ADD CONSTRAINT raw_scraped_leads_freshness_verdict_check CHECK (freshness_verdict IN ('fresh', 'aging', 'stale', 'history', 'undated', 'contradicted'));

-- The live CHECK admitted NULL explicitly ("processing_status IS NULL OR …"); `x IN (…)` passes a NULL x by SQL semantics,
-- so nothing is narrowed — the list gains 'held_stale' and nothing else moves.
ALTER TABLE public.raw_scraped_leads DROP CONSTRAINT IF EXISTS raw_scraped_leads_processing_status_check;
ALTER TABLE public.raw_scraped_leads ADD CONSTRAINT raw_scraped_leads_processing_status_check CHECK (processing_status IN ('pending', 'processing', 'queued_for_enrichment', 'enriching', 'duplicate_pre_enrich', 'duplicate_post_enrich', 'territory_mismatch', 'insufficient_contact_data', 'insufficient_identity', 'insufficient_identity_for_promotion', 'unassigned_no_market', 'held_stale', 'promoted', 'error'));

CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_held_stale ON public.raw_scraped_leads (market_id) WHERE processing_status = 'held_stale';
CREATE INDEX IF NOT EXISTS idx_raw_scraped_leads_last_verified ON public.raw_scraped_leads (last_verified_at) WHERE last_verified_at IS NOT NULL;

COMMENT ON COLUMN public.raw_scraped_leads.last_verified_at IS
  'Wave 151 (lane 151C): when a source most recently re-confirmed this observation. Set to observed_at on insert; bumped by lib/kernel/scraping.ts on a C35 replay. The anchor the owner-record / investor-population freshness policies age from (lib/lead-pipeline/freshness.ts).';
COMMENT ON COLUMN public.raw_scraped_leads.freshness_verdict IS
  'Wave 151 (lane 151C): the freshness policy verdict at the last judgement (lib/lead-pipeline/freshness.ts FRESHNESS_VERDICTS). stale / history / contradicted rows are HELD (processing_status held_stale) — never enriched or promoted on that signal.';
