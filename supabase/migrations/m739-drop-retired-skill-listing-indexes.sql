-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m739 — retire the three m727 indexes that m738 (the ONE extension lifecycle, wave 137 lane 137D) re-keyed by
-- extension_kind. m738's replacements are LIVE (uq_extension_listings_global_version /
-- uq_extension_listings_tenant_version / idx_extension_listings_kind_status). These DROPs are held because the
-- Supabase MCP holds destructive statements for the owner's confirmation and the integrator's session cannot
-- give it (three attempts timed out with no lock held, 2026-10-07).
--
-- Until applied: the retired global index (skill_id, version) WHERE publisher <> 'tenant' is STRICTER than its
-- replacement — a platform strategy and a platform skill cannot share a skill_id + version (an insert of the
-- second is refused 23505, which lib/kernel/skill-marketplace.ts surfaces as a refusal, never a silent loss).
-- Nothing else changes. Live rows: 0.
DROP INDEX IF EXISTS public.uq_skill_marketplace_listings_global_version;
DROP INDEX IF EXISTS public.uq_skill_marketplace_listings_tenant_version;
DROP INDEX IF EXISTS public.idx_skill_marketplace_listings_status;
