-- supabase/migrations/m645-cma-comp-supplement-cache.sql
--
-- ── APPLIED LIVE 2026-09-17 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m645_cma_comp_supplement_cache) ──
--
-- Lane 70A (wave 70). Owner ruling verbatim (2026-09-17): "comps for sold were being pulled
-- from rentcast … I guess it wouldn't hurt to also add comps from batchdata to help with the
-- ai to analyze for cma's but need to best output for property appraisal adjusted comps
-- without high costs."
--
-- WHY THIS TABLE: BatchData's comps dataset pull in lib/cma/comp-provider.ts only runs when
-- RentCast's sold set is short of the required 3-sold mix (already the minority case per wave
-- 69B), but a re-generated CMA for the SAME subject address on the SAME day (a retry, a second
-- agent, a presentation refresh) re-paid for the identical BatchData pull. This table caches
-- that pull's raw payload per (address_key, fetched_on) so a same-day repeat is a cache hit,
-- never a second charge. Orphan doctrine (§1) checked first: no existing cma_* table (see
-- scripts/schema-snapshot.ts cma_comparables/cma_packages/cma_price_adjustments/cma_reports)
-- caches a raw provider payload keyed by address+day — this is a BUILD, not a merge.
--
-- Reader (same wave): lib/cma/comp-supplement-cache.ts::getCachedCompSupplement /
-- setCachedCompSupplement, called from lib/cma/comp-provider.ts's BatchData supplement branch.
--
-- No RLS policy: this table holds no brokerage_id and no tenant-scoped data — a BatchData
-- comp row for a given street address is the same regardless of which brokerage's CMA asked
-- for it, so caching it per-tenant would multiply the exact cost this table exists to remove.
-- It is read and written ONLY through the service-role client in comp-supplement-cache.ts,
-- same as every other platform-owned provider cache in this codebase (e.g. narration_cache).

CREATE TABLE IF NOT EXISTS cma_comp_supplement_cache (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Loose, lower-cased, punctuation-collapsed address key — the SAME normalization
  -- convention comp-provider.ts's own normalizeAddress() and this file's addressKeyOf()
  -- use, so a cache miss never silently duplicates a row for the "same" address spelled
  -- differently by two callers within the tolerance that convention already accepts.
  address_key text NOT NULL,
  fetched_on  date NOT NULL DEFAULT CURRENT_DATE,
  -- The BatchData comps dataset rows + which rail served them ("mcp" | "rest"), verbatim —
  -- see lib/cma/comp-supplement-cache.ts CachedCompSupplementPayload.
  payload     jsonb NOT NULL,
  -- What THIS row's pull cost, in cents — audit only, never re-charged on a cache hit.
  cost_cents  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (address_key, fetched_on)
);

CREATE INDEX IF NOT EXISTS idx_cma_comp_supplement_cache_lookup
  ON cma_comp_supplement_cache (address_key, fetched_on);

COMMENT ON TABLE cma_comp_supplement_cache IS
  'Per-subject-address, per-day cache of the BatchData CMA sold-comp supplement pull (lib/cma/comp-provider.ts). Platform-owned provider cache, no tenant scoping — same address = same cached payload regardless of which brokerage asked. Wave 70, m645.';
