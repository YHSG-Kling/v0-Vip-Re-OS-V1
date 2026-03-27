-- Add sources (array of platform names) and weight (intent signal strength 1-5) to lead_scraping_keywords.
-- These are referenced throughout the lead-scraping cron but were missing from the table definition.

ALTER TABLE public.lead_scraping_keywords
  ADD COLUMN IF NOT EXISTS sources text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS weight integer NOT NULL DEFAULT 1;
