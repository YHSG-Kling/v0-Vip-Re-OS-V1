-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
-- m662 — Marketplace + cash buyers ON by default; scrape keyword types for relocation and
--        realtor-seeking (wave 83, lane 83A)
--
-- Owner verbatim (2026-09-26): "marketplace and cashbuyer should be turned on." · "on scrape
-- sources, make sure keywords are setup and correct."
--
-- LIVE before (hrvaqgvukzxfskkcrwbt, read 2026-09-26):
--   lead_scraping_markets.enabled_sources DEFAULT '{batchdata_motivated}'::text[]; 0 market rows.
--   lead_scraping_keywords: 0 rows; CHECK keyword_type IN
--     ('motivated_seller','buyer','investor','fsbo','expired').
--
-- 1. The column default becomes THE ONE default list the code carries
--    (lib/lead-pipeline/source-intent-map.ts::DEFAULT_MARKET_SOURCES — scripts/scrape-keywords-guard.ts
--    parses this file and holds the two equal). createScrapingMarket already stamps the list
--    explicitly; the default covers every other writer (e.g. lib/platform/deal-room-demo.ts).
-- 2. EXISTING markets get the two sources appended where absent (the owner said "turned on", not
--    "on for new markets") — additive, never removes a source a tenant chose.
-- 3. keyword_type admits 'relocation' and 'realtor_seeking' — the two owner populations the CHECK
--    could not store (scrape-keywords.ts::KEYWORD_TYPE_INTENT maps them). The admin panel reads its
--    options from scripts/check-vocabularies.ts, so REGENERATE that cache after applying.
--
-- Postconditions (run after apply; each must return 0):
--   SELECT count(*) FROM lead_scraping_markets
--     WHERE NOT (enabled_sources @> ARRAY['facebook_marketplace','batchdata_cash_buyer']::text[]);
--   SELECT count(*) FROM information_schema.columns
--     WHERE table_name='lead_scraping_markets' AND column_name='enabled_sources'
--       AND column_default <> '''{batchdata_motivated,facebook_marketplace,batchdata_cash_buyer}''::text[]';

BEGIN;

ALTER TABLE public.lead_scraping_markets
  ALTER COLUMN enabled_sources SET DEFAULT '{batchdata_motivated,facebook_marketplace,batchdata_cash_buyer}'::text[];

UPDATE public.lead_scraping_markets
   SET enabled_sources = (
         SELECT array_agg(DISTINCT s ORDER BY s)
           FROM unnest(coalesce(enabled_sources, '{}'::text[]) || ARRAY['facebook_marketplace','batchdata_cash_buyer']::text[]) AS s
       )
 WHERE NOT (coalesce(enabled_sources, '{}'::text[]) @> ARRAY['facebook_marketplace','batchdata_cash_buyer']::text[]);

ALTER TABLE public.lead_scraping_keywords DROP CONSTRAINT IF EXISTS lead_scraping_keywords_keyword_type_check;
ALTER TABLE public.lead_scraping_keywords
  ADD CONSTRAINT lead_scraping_keywords_keyword_type_check
  CHECK (keyword_type = ANY (ARRAY['motivated_seller','buyer','investor','fsbo','expired','relocation','realtor_seeking']::text[]));

COMMIT;
