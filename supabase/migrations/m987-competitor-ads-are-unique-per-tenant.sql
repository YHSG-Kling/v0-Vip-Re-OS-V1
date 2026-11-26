-- ── APPLIED LIVE 2026-11-18 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 154, integrator ── read back: unique index uq_competitor_ads_tenant_source_provider on (brokerage_id, source_platform, provider_ad_id), not partial; the old global partial index uq_competitor_ads_source_provider_id still present (owner SQL drops it)
--
-- m987 — a competitor ad is stored once PER TENANT, and the ad writer can finally write.
--
-- MEASURED LIVE 2026-11-18 (project hrvaqgvukzxfskkcrwbt): public.competitor_ads holds 0 rows. Its only unique index besides
-- the primary key is uq_competitor_ads_source_provider_id — GLOBAL (no brokerage_id) and PARTIAL (WHERE provider_ad_id IS NOT
-- NULL). app/api/cron/competitor-ads-exa/route.ts upserted with onConflict "source_platform,provider_ad_id". PostgREST sends
-- ON CONFLICT (source_platform, provider_ad_id) with no predicate, Postgres cannot infer a partial index from that (42P10), so
-- every upsert was refused whole and the table stayed empty. Had the index been inferable, one tenant's upsert would have
-- UPDATED another tenant's row, because the key carries no tenant.
--
-- This index is NOT partial (so the conflict target is inferable) and LEADS WITH THE TENANT (so a conflict can only ever be the
-- tenant's own row). Rows with a NULL provider_ad_id stay distinct (NULLs are distinct in a unique index), as before.
--
-- NOT in this migration (owner SQL, recorded in docs/operations/OWNER-SQL): dropping the old global index. Until it is dropped,
-- a second tenant storing the SAME ad is refused with 23505 by the old index — a refusal the writer reads and reports, never an
-- overwrite of the first tenant's row.

CREATE UNIQUE INDEX IF NOT EXISTS uq_competitor_ads_tenant_source_provider
  ON public.competitor_ads (brokerage_id, source_platform, provider_ad_id);
