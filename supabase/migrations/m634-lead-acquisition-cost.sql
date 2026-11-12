-- m634 — LEAD ACQUISITION COST (leads.acquisition_cost, contacts.acquisition_cost)
-- ── APPLIED LIVE 2026-09-15 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m634_lead_acquisition_cost) ──
--
-- Lane 65D, owner ruling (wave 65 verbatim): "...where they came from for lead
-- cost tracking." Per-lead acquisition cost = the raw record's cost_per_record
-- + enrichment spend (vendor_usage_tracking rows keyed to this lead_id) +
-- source campaign cost share (ad_campaigns.lifetime_budget split across the
-- leads sharing that campaign_attribution_id). `leads.cost_per_record` /
-- `contacts.cost_per_record` already exist and already carry losslessly
-- (verified against scripts/schema-snapshot.ts and
-- lib/contact-promotion/contact-creator.ts's contactData) — but that column is
-- the narrower RAW RECORD cost (what the scrape/list cost per row), the same
-- number app/actions/source-analytics.ts sums today. It is NOT redefined here
-- (§6 — that would silently change a live reader's meaning). `acquisition_cost`
-- is additive: the fuller, computed figure this lane's
-- lib/contact-promotion/acquisition-cost.ts writes at promotion, read
-- preferentially (falling back to cost_per_record on older rows) by
-- lib/lead-pipeline/source-conversion-runner.ts's loadSourceConversions.
--
-- Idempotent (IF NOT EXISTS) and fail-soft (skips a table that lost its shape).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'leads' AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS acquisition_cost numeric;
    COMMENT ON COLUMN public.leads.acquisition_cost IS
      'cost_per_record + enrichment spend (vendor_usage_tracking.total_cost by lead_id) + source campaign cost share — computed at promotion by lib/contact-promotion/acquisition-cost.ts. NULL = not yet computed; readers fall back to cost_per_record.';
  ELSE
    RAISE NOTICE 'm634: skipping leads — table not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'contacts' AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS acquisition_cost numeric;
    COMMENT ON COLUMN public.contacts.acquisition_cost IS
      'Carried from leads.acquisition_cost at conversion (lib/contact-promotion/contact-creator.ts) — the full acquisition cost of the person who is now this contact, for lifetime-value / cost-per-conversion reporting.';
  ELSE
    RAISE NOTICE 'm634: skipping contacts — table not found';
  END IF;
END
$$;

-- AFTER APPLYING: regenerate the schema caches (CLAUDE.md §3) —
--   npm run schema:regen
-- Expected: leads / contacts each gain one column (`acquisition_cost`) in
-- scripts/schema-snapshot.ts. No CHECK added, so no vocabulary-cache regen
-- needed.
