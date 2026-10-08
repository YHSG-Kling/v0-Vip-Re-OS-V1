-- supabase/migrations/m652-review-source-urls.sql
--
-- ── APPLIED LIVE 2026-09-18 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m652_review_source_urls) ──
--
-- Lane 74D. Closes docs/lead-acquisition-coverage-2026-09.md item #31 ("review/reputation
-- chatter (as an ACQUISITION signal, not just reputation response)").
--
-- lib/lead-pipeline/review-acquisition-sourcer.ts scrapes the tenant's PUBLIC Google Business
-- Profile / Zillow agent-profile / Facebook Page review feeds for reviewer questions that carry
-- real-estate intent. Unlike facebook_group_urls (which the cron falls back to a GUESSED
-- `/groups/<city>realestate` URL when unconfigured — a plausible guess for a generic city group),
-- there is no plausible guess for WHICH Google Business Profile belongs to a given brokerage, so
-- this lane requires the tenant to configure real page URLs. Same table, same shape as the
-- existing facebook_group_urls column this migration sits beside.
alter table public.lead_scraping_motivated_params
  add column if not exists review_source_urls text[] not null default '{}';

comment on column public.lead_scraping_motivated_params.review_source_urls is
  'Public review/comment page URLs (Google Business Profile, Zillow agent profile, Facebook Page) this market''s review-acquisition lane scrapes for real-estate-question reviewers. Empty by default — no configured URL, no scrape (territory-honesty contract, lib/lead-pipeline/review-acquisition-sourcer.ts). m652.';
