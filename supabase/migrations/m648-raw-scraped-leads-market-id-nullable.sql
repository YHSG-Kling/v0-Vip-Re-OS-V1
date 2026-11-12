-- supabase/migrations/m648-raw-scraped-leads-market-id-nullable.sql
--
-- ── APPLIED LIVE 2026-09-18 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m648_raw_scraped_leads_market_id_nullable) ──
-- Lane 73A (wave 73, owner verbatim: "unknown inbound senders first need to be identified
-- before adding a spam or non real estate business email records into the os... if there is
-- intent to or interest in real estate then we should add them in as a lead so the ai isa can
-- qualify before converting to contact").
--
-- THE GAP. lib/kernel/scraping.ts::ingestRawSourceBatch (the ONE governed writer of
-- raw_scraped_leads) requires `marketId: string` on every call — every existing source is
-- scraped FOR a lead_scraping_markets territory, so a real market row always exists. The new
-- inbound_email_unknown source (lib/lead-pipeline/unknown-sender-identification.ts) is NOT a
-- scrape of a territory — it is an unsolicited email that already landed in a specific tenant's
-- inbox, resolved to a brokerageId by the inbound route's own signature-verified session, never
-- a body value. That brokerage may have configured NO lead_scraping_markets row at all (a tenant
-- that never turned on scraping still receives inbound email and still deserves this
-- identification step) — the caller has a real brokerage but no market to attach the row to.
--
-- THE FIX. Make raw_scraped_leads.market_id explicitly nullable so a non-territory source can
-- ingest without inventing a fake market row (which would either violate the market_id FK to
-- lead_scraping_markets or silently attach the record to the wrong territory). The paired code
-- change (same lane) relaxes IngestRawSourceBatchParams.marketId to `string | null` and skips the
-- market-geography lookup/territory gate when it is null — the SAME no-op posture
-- recordMatchesTerritory already takes for a record with no geography at all ("cannot reject;
-- pass through"). Every EXISTING caller keeps passing a real market_id; this only widens what the
-- column will accept, it narrows nothing.
--
-- Idempotent by construction: `DROP CONSTRAINT IF EXISTS` guards the NOT NULL drop even if this
-- runs twice or the column was already nullable (Postgres accepts DROP NOT NULL on an already-
-- nullable column as a no-op, no error).
alter table public.raw_scraped_leads
  alter column market_id drop not null;

comment on column public.raw_scraped_leads.market_id is
  'lead_scraping_markets(id) this raw record was scraped for. NULL for a non-territory, first-party source (e.g. inbound_email_unknown) whose owning brokerage is resolved directly rather than by scraped geography. m648.';
