-- ── APPLIED LIVE 2026-09-28 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m676 — lane 88G (wave 88, lead-scraping lane: lane-87F's eight scraping gaps).
--
-- LIVE, READ 2026-09-28 (project hrvaqgvukzxfskkcrwbt, before writing this):
--   · lead_deduplication_log_stage_check admits ONLY
--       ('pre_enrichment','post_enrichment','viability_gate','lead_creation')
--     but lib/lead-pipeline/pipeline-processor.ts writes three more stages on every gate refusal —
--     'territory_gate', 'identity_gate', 'promotion_identity_gate'. supabase-js RESOLVES the refusal
--     and the old logDeduplication only had a try/catch, so every territory / identity / lead-gate
--     refusal was silently NOT logged — the person timeline's dedup_decision events
--     (lib/lead-intelligence/person-timeline.ts) could never show WHY a raw row stayed raw.
--     lead_deduplication_log: 0 rows live (nothing to backfill; the widening is additive).
--   · motivated_seller_signals_external_dedupe (m636's list, 27 types) does not name
--     'price_reduced' — the type lane 88G adds to lib/external/batchdata-seller-signals.ts
--     (PRICE_REDUCED_SIGNAL_TYPE, filed by the active-listing monitor on a list-price drop).
--     A type declared in code and not in this index carries NO uniqueness rule (m490/m499/m514/
--     m517/m520/m521/m632/m636 — the same lesson). motivated_seller_signals: 0 rows live, so a plain
--     DROP + CREATE is safe (re-measure before applying).
--
-- NOT CHANGED (checked): lead_scraping_markets.enabled_sources default
-- '{batchdata_motivated,facebook_marketplace,batchdata_cash_buyer}' (m662) — lane 88G adds no
-- SourceKey and no default-on source; lead_scraping_motivated_params has NO CHECK on signal_types
-- (text[] default '{}'), so the three new BatchData triggers need no vocabulary change.
--
-- AFTER APPLYING: regenerate scripts/check-vocabularies.ts (a CHECK changed) — the stage list below
-- must reach lead_deduplication_log.stage there.

-- PART A — the gate stages the pipeline already writes.
ALTER TABLE public.lead_deduplication_log DROP CONSTRAINT IF EXISTS lead_deduplication_log_stage_check;
ALTER TABLE public.lead_deduplication_log ADD CONSTRAINT lead_deduplication_log_stage_check
  CHECK (stage = ANY (ARRAY[
    'pre_enrichment'::text,
    'post_enrichment'::text,
    'viability_gate'::text,
    'lead_creation'::text,
    'territory_gate'::text,
    'identity_gate'::text,
    'promotion_identity_gate'::text
  ]));

-- PART B — widen the seller-signal dedupe index by 'price_reduced'.
DROP INDEX IF EXISTS public.motivated_seller_signals_external_dedupe;

CREATE UNIQUE INDEX motivated_seller_signals_external_dedupe
  ON public.motivated_seller_signals
  USING btree (signal_type, ((signal_details ->> 'dedupe_key'::text)))
  WHERE ((signal_type = ANY (ARRAY[
            'permit_activity'::text,
            'code_violation'::text,
            'sale_propensity'::text,
            'preforeclosure'::text,
            'tax_delinquent'::text,
            'involuntary_lien'::text,
            'vacancy'::text,
            'absentee_owner'::text,
            'tired_landlord'::text,
            'listing_withdrawn'::text,
            'high_equity'::text,
            'market_timing'::text,
            'for_sale_by_owner'::text,
            'listed_below_market'::text,
            'corporate_owned'::text,
            'fix_and_flip'::text,
            'vacant_lot'::text,
            'active_listing'::text,
            'trust_owned'::text,
            'inherited_property'::text,
            'senior_owner'::text,
            'recent_divorce'::text,
            'household_outgrown'::text,
            'cash_buyer'::text,
            'expired_listing'::text,
            'withdrawn'::text,
            'sold'::text,
            'price_reduced'::text
         ]))
         AND (signal_details ? 'dedupe_key'::text));

COMMENT ON INDEX public.motivated_seller_signals_external_dedupe IS
  'One signal per (signal_type, dedupe_key) for every EXTERNAL seller-signal sweep. m676 widens m636''s list by price_reduced (the active-listing monitor''s list-price drop, lane 88G). The `signal_details ? dedupe_key` predicate stays deliberate — see m632''s own comment.';

-- POSTCONDITIONS (run after applying; each must return true):
--   select pg_get_constraintdef(oid) like '%promotion_identity_gate%' from pg_constraint where conname = 'lead_deduplication_log_stage_check';
--   select indexdef like '%price_reduced%' from pg_indexes where indexname = 'motivated_seller_signals_external_dedupe';
