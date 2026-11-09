-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, integrator (owner SQL L2, owner ruling "L2 drop" 2026-11-09) ──
--
-- OWNER-SQL §L L2: the global cross-tenant UNIQUE on raw observations (source, source_record_id). Wave 150's m961 replaced
-- it with the tenant-scoped idempotency key (raw_scraped_leads_idempotency_key_uniq); the global one let one tenant's
-- observation of a public record block every other tenant's.
--
-- §L L2 wrote DROP INDEX; the unique is a CONSTRAINT (DROP INDEX refused with 2BP01), so the constraint is dropped and its
-- index goes with it — the same owner intent.
-- Pre-check (live, 2026-11-09): constraint + index present; raw_scraped_leads_idempotency_key_uniq present; 0 rows.
-- Read-back: constraint 0, index 0; unique indexes = raw_scraped_leads_idempotency_key_uniq, raw_scraped_leads_pkey.
-- Reversible while (source, source_record_id) is unique across tenants: ALTER TABLE public.raw_scraped_leads
--   ADD CONSTRAINT raw_scraped_leads_source_record_id_key UNIQUE (source, source_record_id);

ALTER TABLE public.raw_scraped_leads DROP CONSTRAINT IF EXISTS raw_scraped_leads_source_record_id_key;
