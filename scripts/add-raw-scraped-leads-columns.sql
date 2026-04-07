-- Add columns required by insertRawRecord() spec to raw_scraped_leads.
-- All additions are idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.raw_scraped_leads
  ADD COLUMN IF NOT EXISTS market_id            uuid         REFERENCES public.lead_scraping_markets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_record_id     text,
  ADD COLUMN IF NOT EXISTS normalized_preview   jsonb,
  ADD COLUMN IF NOT EXISTS scraper_execution_id uuid         REFERENCES public.scraper_executions(id) ON DELETE SET NULL;

-- Unique constraint: one raw record per source + source_record_id to prevent exact duplicates.
-- Use IF NOT EXISTS via a DO block (Postgres 9.5+).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'raw_scraped_leads_source_record_id_key'
  ) THEN
    ALTER TABLE public.raw_scraped_leads
      ADD CONSTRAINT raw_scraped_leads_source_record_id_key
      UNIQUE (source, source_record_id);
  END IF;
END$$;
