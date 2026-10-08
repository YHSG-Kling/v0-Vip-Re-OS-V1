-- m279 — Align is_lead_visible_role() with the app-layer LEAD_DESK_ROLES
-- (app/actions/lead-management.ts). Business rule: agents work CONTACTS;
-- LEADS are the broker/admin desk + the AI-ISA lane until converted.
--
-- Drift resolved in BOTH directions:
--   - team_lead/team_leader/compliance_officer/compliance_manager had RLS read
--     access while the app redirects them off every leads surface — dropped.
--   - broker_admin passed the app gate but was MISSING here, so their leads
--     desk rendered silently empty (RLS nulled every row) — added.
--   - superadmin user_type added for parity with LEAD_DESK_ROLES (platform
--     staff already covered via is_platform_admin()).
--
-- Live-proven under impersonation: agent 0 rows, compliance_officer 0 rows,
-- broker 1 row on a seeded probe lead (probe cleaned up).
CREATE OR REPLACE FUNCTION public.is_lead_visible_role()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT user_type IN ('broker', 'broker_owner', 'broker_admin',
                          'admin', 'superadmin')
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  ) OR public.is_ai_isa_system() OR public.is_platform_admin();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;
