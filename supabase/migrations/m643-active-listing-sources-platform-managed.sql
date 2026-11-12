-- supabase/migrations/m643-active-listing-sources-platform-managed.sql
--
-- ── APPLIED LIVE 2026-09-17 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m643_active_listing_sources_platform_managed) ──
--
-- Lane 69A (wave 69). Owner ruling verbatim (2026-09-17): "rentcast is platform provided but
-- idx is for tenant connected if the tenant has this connection instead of rentcast option for
-- for sale properties. the setting page should only allow them to setup their idx connection."
--
-- WAVE 68's brokerage_settings.active_listing_sources (m642, applied live 2026-09-16) was an
-- ORDERED LIST the tenant could reorder/exclude — idx and rentcast were STORED, tenant-chosen
-- values. That is retired: idx-vs-rentcast is now DERIVED on every read from the brokerage's IDX
-- credential (lib/buyer-search/listing-source-order.ts::resolveActiveListingSources, via the
-- same cascade scripts/idx-tenant-credential-simulator.ts proves), never a stored choice. The
-- ONE thing left in this column is whether PLATFORM STAFF have opted this brokerage into the
-- billed BatchData on-market pull (a platform cost decision — app/actions/superadmin/
-- active-listing-sources.ts::setBrokerageActiveListingSourcesAction, requireSuperadmin-gated).
-- The tenant-facing checklist (app/dashboard/settings/integrations/lead-sources) and its write
-- seam (app/actions/settings/active-listing-sources.ts) are DELETED — see the tombstone at
-- lib/buyer-search/listing-source-order.ts:1.
--
-- NO SCHEMA CHANGE beyond the DEFAULT and the COMMENT: the column stays `jsonb NOT NULL`, the
-- `jsonb_typeof(...) = 'array'` CHECK from m642 is untouched, and existing rows (whatever a
-- brokerage last saved under the wave-68 checklist, e.g. `["idx","rentcast"]`) are left as-is —
-- they are simply never read as an idx/rentcast ranking again; a row that happens to name
-- "batchdata_on_market" keeps meaning exactly what it always meant. The DEFAULT drops to `[]`
-- because "idx"/"rentcast" are no longer stored values at all (they are derived), so a brand new
-- brokerage's row correctly starts with the billed pull OFF and nothing else.

ALTER TABLE public.brokerage_settings
  ALTER COLUMN active_listing_sources SET DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.brokerage_settings.active_listing_sources IS
  'PLATFORM-STAFF-MANAGED (wave 69 owner ruling — see docs/lead-acquisition-coverage-2026-09.md).
   Written ONLY by app/actions/superadmin/active-listing-sources.ts::
   setBrokerageActiveListingSourcesAction (requireSuperadmin-gated) — never a tenant write path.
   Read for EXACTLY ONE purpose: does this brokerage opt into the BILLED BatchData on-market
   quicklist pull? Allowed member: "batchdata_on_market" (absent/empty = off, the default).
   "idx" and "rentcast" are NO LONGER READ FROM THIS COLUMN — that choice is DERIVED on every
   call from the brokerage''s own IDX Broker credential
   (lib/buyer-search/listing-source-order.ts::resolveActiveListingSources), never stored.
   Reader: lib/buyer-search/listing-source-order.ts::resolveActiveListingSources — never a
   second reader. Investor-persona contacts are unaffected (served exclusively by the off-market
   BatchData rail, lib/buyer-search/investor-offmarket-runner.ts, which this setting does not
   gate).';
