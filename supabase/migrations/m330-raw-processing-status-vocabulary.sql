-- m330: close the scrape loop's last open vocabulary.
--
-- raw_scraped_leads.processing_status is the gate the entire lead pipeline turns
-- on — a scraped record's whole fate is this one string — and it was the only
-- column on the table with NO CHECK. source_family and source_origin both had
-- one; this did not. That made it invisible to test:check-vocabulary, which
-- works by comparing code literals against the database's admitted set: a column
-- with no set cannot be covered.
--
-- The failure mode it leaves open, in that guard's own words: supabase-js
-- resolves with {error} rather than throwing and these writes are best-effort,
-- so a value outside the set does not crash — it LOSES THE ROW IN SILENCE. On
-- the read side a filter on an impossible value returns zero rows and reads as
-- "no data yet" forever.
--
-- The list is generated from lib/lead-pipeline/processing-status.ts, which
-- pipeline-processor and lead-intake-cockpit now both import, so the database
-- and the code cannot disagree. Before this, the cockpit hand-copied a subset
-- with the comment "kept verbatim" — two hand-maintained lists of one vocabulary.
--
-- Safe to apply: raw_scraped_leads is empty live (0 rows), so there is no
-- backfill and no historical row this could invalidate. Verified live that all
-- 13 canonical values insert and a drifted 'completed' is refused.
alter table raw_scraped_leads
  drop constraint if exists raw_scraped_leads_processing_status_check;

alter table raw_scraped_leads
  add constraint raw_scraped_leads_processing_status_check
  check (processing_status is null or processing_status in (
    -- in-flight
    'pending',
    'processing',
    'queued_for_enrichment',
    'enriching',
    -- gate-stop reasons, each one actionable by a human
    'duplicate_pre_enrich',
    'duplicate_post_enrich',
    'territory_mismatch',
    'insufficient_contact_data',
    'insufficient_identity',
    'insufficient_identity_for_promotion',
    'unassigned_no_market',
    -- terminal
    'promoted',
    'error'
  ));

comment on column raw_scraped_leads.processing_status is
  'Lead-pipeline gate state. Vocabulary is generated from lib/lead-pipeline/processing-status.ts (m330) — add a value there and here together, never one alone.';
