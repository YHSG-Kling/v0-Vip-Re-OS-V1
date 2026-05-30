-- =====================================================
-- MIGRATION 033: Canonical Auth Helper Functions
-- =====================================================
-- Deploys the helper-function suite that
-- supabase/rls-governance/000-helper-functions.sql described
-- but was never applied as a migration.
--
-- Schema choice: these live in `public.` (not `auth.`) because the
-- MCP migration tool / project DB URL cannot DDL the `auth` schema
-- (that requires the Supabase Dashboard superuser). `public.*`
-- works identically for SECURITY DEFINER RLS helpers and is the
-- same pattern that current_user_brokerage_id() / current_user_type()
-- already use (see migration 032).
--
-- Key change vs. the governance file: the old is_admin() conflated
-- brokerage admins with the platform super-admin. We split into:
--   - public.is_platform_admin()    -> only platform-tier admins
--   - public.is_brokerage_admin()   -> tenant-scoped admins/brokers
--   - public.is_ai_isa_system()     -> AI-ISA system actor
--   - public.is_lead_visible_role() -> who can see the leads table
-- =====================================================

-- ─── Platform / tenant admin split ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT platform_role = 'superadmin' OR user_type IN ('superadmin', 'super_admin')
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_brokerage_admin()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT user_type IN ('admin', 'broker', 'broker_owner')
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_ai_isa_system()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT platform_role = 'ai_isa_system'
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── Role probes ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_agent_role()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT user_type = 'agent' FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_team_lead_role()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT user_type IN ('team_lead', 'team_leader')
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_compliance_officer_role()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT user_type IN ('compliance_officer', 'compliance_manager')
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── Lead-visibility gate ─────────────────────────────────────────────────────
-- Returns TRUE for roles allowed to read the leads table (subject to
-- brokerage scope). Agents are intentionally NOT included.

CREATE OR REPLACE FUNCTION public.is_lead_visible_role()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT user_type IN ('broker', 'broker_owner', 'admin',
                          'team_lead', 'team_leader',
                          'compliance_officer', 'compliance_manager')
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  ) OR public.is_ai_isa_system() OR public.is_platform_admin();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── Brokerage scope helper ───────────────────────────────────────────────────
-- Only platform admin bypasses isolation. Brokerage admins are strictly scoped.

CREATE OR REPLACE FUNCTION public.has_brokerage_access(target_brokerage_id UUID)
RETURNS BOOLEAN AS $$
  SELECT
    public.is_platform_admin()
    OR (target_brokerage_id IS NOT NULL
        AND target_brokerage_id = public.current_user_brokerage_id());
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── Agent / contact identity ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.current_user_agent_id()
RETURNS UUID AS $$
  SELECT id FROM public.agents WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_own_agent_id(agent_id_to_check UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents
    WHERE id = agent_id_to_check AND user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_contact_id()
RETURNS UUID AS $$
  SELECT id FROM public.contacts WHERE contact_user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_self_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE id = contact_id AND contact_user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.is_platform_admin()             TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_brokerage_admin()            TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_ai_isa_system()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_agent_role()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_team_lead_role()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_compliance_officer_role()    TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_lead_visible_role()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_brokerage_access(UUID)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_agent_id()         TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_own_agent_id(UUID)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_contact_id()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_self_contact(UUID)           TO authenticated;
