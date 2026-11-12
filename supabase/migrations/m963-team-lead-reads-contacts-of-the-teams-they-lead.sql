-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151B ──
--
-- L4 = S3 (lane 150BAA finding; docs/operations/OWNER-SQL.md §L L4; OWNER DECISION, wave 151 directive §151B):
--   "Team leaders may see Contacts belonging to the teams they are authorized to lead. Do not grant brokerage-wide
--    Contact visibility merely because the person is a team leader."
--
-- MEASURED LIVE 2026-11-09 (project hrvaqgvukzxfskkcrwbt, pg_policies):
--   contacts.team_lead_read_team_contacts USING
--     (brokerage_id = current_user_brokerage_id())
--     AND EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type = ANY (ARRAY['team_lead','team_leader']))
--   → tenant + user_type only: every team lead reads the WHOLE brokerage's contacts (CLAUDE.md §4 "teams see only their own board").
--
-- THE RULE THIS INSTALLS (the same shape lib/auth/lead-visibility.ts resolves for leads, and the listings / transactions
-- team-leader policies already use for those tables):
--   · the team-lead FACT is teams.team_lead_id = auth.uid() (CLAUDE.md §4: "Team lead anchors on teams.team_lead_id"), never
--     users.user_type alone — a user_type 'team_lead' who leads no team gains nothing; an 'agent'-typed seat who leads a team
--     (live: teamlead@vip.demo) sees that team;
--   · EVERY team the person leads, not the first one — current_user_led_team_id() is LIMIT 1, so it is not used here;
--   · a contact is the team's when its team_id is a led team, or its agent_id is an agent of a led team — BOTH membership
--     sources (agents.team_id and active team_members rows), plus the team lead's OWN agents row (their own book);
--   · the TENANT PRINCIPAL collapse (m526 is_tenant_principal_team_lead(): plan_tier team / solo_agent AND exactly one live
--     team, led by the caller) keeps the owner's team-tier ruling — on a team tenant the team IS the tenant;
--   · the tenant pin stays first. Platform staff keep platform_admin_read_contacts; every other seat keeps its own policy.
--
-- MCP-applicable: ALTER POLICY only (one statement). The policy NAME is kept so scripts/cross-office-rls-guard.ts's judge
-- (teamLeadBrokerageWide: a contacts read naming 'team_lead' without team_id / team_members / current_user_led_team_id)
-- finds the same row — after this the predicate names team_id and team_members, so the live judge reads 0.

ALTER POLICY team_lead_read_team_contacts ON public.contacts
  USING (
    (brokerage_id = public.current_user_brokerage_id())
    AND (
      public.is_tenant_principal_team_lead()
      OR (
        -- the team-lead FACT: this person leads at least one live team of this tenant
        EXISTS (
          SELECT 1 FROM public.teams t
           WHERE t.team_lead_id = auth.uid() AND t.deleted_at IS NULL
             AND t.brokerage_id = public.current_user_brokerage_id()
        )
        AND (
          -- the contact sits on a led team
          team_id IN (
            SELECT t.id FROM public.teams t
             WHERE t.team_lead_id = auth.uid() AND t.deleted_at IS NULL
               AND t.brokerage_id = public.current_user_brokerage_id()
          )
          -- …or its agent is on a led team (agents.team_id), or is the team lead's OWN agents row (their own book)
          OR agent_id IN (
            SELECT a.id FROM public.agents a
             WHERE a.brokerage_id = public.current_user_brokerage_id()
               AND (
                 a.user_id = auth.uid()
                 OR a.team_id IN (
                   SELECT t.id FROM public.teams t
                    WHERE t.team_lead_id = auth.uid() AND t.deleted_at IS NULL
                      AND t.brokerage_id = public.current_user_brokerage_id()
                 )
               )
          )
          -- …or its agent is an ACTIVE team_members row of a led team (the roster table, effective-dated)
          OR agent_id IN (
            SELECT tm.agent_id FROM public.team_members tm
              JOIN public.teams t ON t.id = tm.team_id
             WHERE t.team_lead_id = auth.uid() AND t.deleted_at IS NULL
               AND t.brokerage_id = public.current_user_brokerage_id()
               AND tm.is_active = true
          )
        )
      )
    )
  );

-- READ-BACK (integrator, after apply):
--   SELECT policyname, regexp_replace(qual, '\s+', ' ', 'g') FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'team_lead_read_team_contacts';
--   → the qual names team_members, teams.team_lead_id and is_tenant_principal_team_lead(), and no user_type array.
-- PROBE (scripts/cross-tenant-read-simulator.ts's set_config pattern; read-only, rolled back):
--   begin;
--   select set_config('request.jwt.claims', json_build_object('sub', '<a seeded non-principal team lead users.id>', 'role', 'authenticated')::text, true);
--   set local role authenticated;
--   select count(*) from public.contacts;   -- falls from tenant-wide to the led team's rows (+ the lead's own book)
--   rollback;
