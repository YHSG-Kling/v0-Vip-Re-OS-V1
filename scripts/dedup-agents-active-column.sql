-- dedup-agents-active-column.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- LIVE-SCHEMA DEDUP (applied via Supabase migration `dedup_agents_active_into_is_active`).
--
-- The agents table carried TWO boolean active flags — is_active (nullable, default true) and
-- active (NOT NULL, default true) — with identical data on every row (verified: 0 divergent).
-- is_active is the code-canonical column (35 refs vs 6). This consolidates onto is_active and
-- drops the duplicate `active`.
--
-- Pre-flight verified before applying:
--   • is_active = active on all rows (no data loss)
--   • no views, RLS policies, or triggers reference `active`
--   • all 6 code refs to agents.active migrated to is_active first
--     (leads.ts, lib/kernel/users.ts, agent-coaching.ts, commission-forecaster.ts)
-- Post-apply: schema-drift guard reports zero straggler agents.active refs.

UPDATE public.agents SET is_active = active WHERE is_active IS NULL;
ALTER TABLE public.agents ALTER COLUMN is_active SET DEFAULT true;
ALTER TABLE public.agents ALTER COLUMN is_active SET NOT NULL;
ALTER TABLE public.agents DROP COLUMN active;
