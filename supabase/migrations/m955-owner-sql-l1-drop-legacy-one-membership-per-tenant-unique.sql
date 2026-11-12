-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, integrator (owner SQL L1, owner ruling "L1 drop" 2026-11-09) ──
--
-- O-150C-1 (OWNER-SQL §L L1): the legacy one-membership-per-tenant UNIQUE on organization_members. Wave 150's m958 made
-- memberships explicit per SCOPE (organization_members_active_scope_key — brokerage / office / team); this brokerage-wide
-- unique would have refused a user's second office or team membership inside the same tenant.
--
-- Pre-check (live, 2026-11-09): constraint present; organization_members_active_scope_key present; 0 rows.
-- Read-back: constraint 0; unique indexes = organization_members_active_scope_key, organization_members_pkey.
-- Reversible while every (user, brokerage) pair is unique: ALTER TABLE public.organization_members
--   ADD CONSTRAINT organization_members_brokerage_id_user_id_key UNIQUE (brokerage_id, user_id);

ALTER TABLE public.organization_members DROP CONSTRAINT IF EXISTS organization_members_brokerage_id_user_id_key;
