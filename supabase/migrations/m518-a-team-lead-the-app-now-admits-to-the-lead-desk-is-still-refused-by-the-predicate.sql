-- m518 — a team lead the app now admits to the lead desk is still refused by the predicate.
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULING (verbatim):
--
--   "if team tier subscriptions, they don't have a broker in the subscription so
--    the team lead can see leads."
--
-- STANDING RULINGS THIS MUST NOT BREAK (CLAUDE.md §4/§5, all still in force):
--   · Team lead anchors on `teams.team_lead_id`. A TEAM IS A MINI BROKERAGE.
--   · Teams see only their own board; platform sees all tenants.
--   · Leads belong to the BROKERAGE. Agents never see leads, only contacts.
--
-- WHAT IS WRONG TODAY. m308 rewrote public.is_lead_visible_role() to read BOTH
-- role sources — users.user_type AND user_role_assignments — and to drop the
-- phantom 'broker_admin'. It did not name `team_lead` in either branch, and it
-- could not have: at the time every app roster refused team_lead too, so app and
-- database agreed. The app half has now moved (lib/auth/lead-visibility.ts), and
-- an app gate that ADMITS while RLS REFUSES is the worst of the two directions:
-- supabase-js RESOLVES a refused read, the statement matches zero rows, `error`
-- is null, and the surface renders an EMPTY BOARD as if the team simply had no
-- leads. Nothing errors, nothing logs, and the team lead is told their pipeline
-- is empty. This migration removes that disagreement.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HONEST SCOPE — READ THIS BEFORE ASSUMING WHAT IT CLOSES.
--
-- THIS PREDICATE CANNOT EXPRESS TEAM SCOPE, AND THIS MIGRATION DOES NOT CLAIM TO.
--
-- `is_lead_visible_role()` takes NO ARGUMENTS and returns a single boolean about
-- the CURRENT USER. It is composed in leads_select as
--
--     is_platform_admin() OR (is_lead_visible_role() AND has_brokerage_access(brokerage_id))
--
-- so the only ROW-dependent term in that policy is has_brokerage_access(), which
-- answers a BROKERAGE question. A row-level "…and this lead belongs to my team"
-- term does not exist in the policy and cannot be added from inside this
-- function, because the function never sees the row.
--
-- Worse, the row-level fact is not directly available on `leads` at all:
-- MEASURED against the live column list, `leads` has NO team column. A lead's
-- only link to a team is `leads.agent_id -> agents.team_id`, and an UNWORKED
-- lead has `agent_id IS NULL` — it belongs to the brokerage and to no team.
--
-- SO, PLAINLY:
--
--   · WHAT THIS CLOSES: a team lead's queries against `leads` stop returning
--     zero rows for the wrong reason. The database now agrees with the app that
--     a team lead is a lead-desk role at all.
--
--   · WHAT THIS DOES NOT CLOSE, AND WHAT THAT LEAVES OPEN: at the PREDICATE
--     level, admitting team_lead admits them to EVERY lead row in their own
--     brokerage (the brokerage pin from has_brokerage_access still holds — this
--     is not cross-tenant). The narrowing to one team's rows is APPLICATION-LAYER
--     ONLY, in lib/auth/lead-visibility.ts#applyLeadRowScope, which adds
--     `.in("agent_id", <the team's agents>)` to every lead read and write.
--
--     Concretely, what remains reachable for a team lead on a MULTI-TEAM tenant:
--       – any authenticated request that queries `leads` WITHOUT going through
--         lib/auth/lead-visibility.ts — a new surface, a direct PostgREST call
--         with the user's own JWT, or an existing surface that is refactored and
--         drops the scope. RLS will not stop it.
--       – the ~30 policies that fan out from this predicate onto lead-dependent
--         tables. They inherit the same brokerage-level admission.
--     On a tenant whose ONLY team is the team lead's own — the tier the owner's
--     ruling is actually about — there is nothing left open at all: team scope
--     and brokerage scope are the same set of rows, and the app resolver
--     collapses to brokerage scope for exactly that reason.
--
--   · WHAT WOULD ACTUALLY CLOSE IT, named rather than hand-waved: a second,
--     ROW-TAKING predicate — `public.is_lead_in_my_team_scope(lead_agent_id uuid)`
--     — ANDed into leads_select for the team_lead branch, resolving
--     `agents.team_id` against `teams.team_lead_id = auth.uid()`. That is a
--     policy rewrite touching leads_select and the dependent policies, and it is
--     NOT attempted here: this lane owns the predicate, not the ~30 policies
--     that read it, and half a policy rewrite is worse than none. It is written
--     down so the next lane inherits the decision rather than the surprise.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SHAPE PRESERVED FROM m308, deliberately and in full:
--   · the TWO BRANCHES — users.user_type and user_role_assignments — because a
--     brokerage may grant someone a role without it being their primary type.
--     Live at m308's measurement: 7 assignments across 4 users, 3 of them
--     disagreeing with that user's user_type. team_lead is added to BOTH, or the
--     grant-held team lead stays locked out exactly as the primary-type one was.
--   · `public.is_ai_isa_system()` — the AI-ISA system actor follows up and
--     qualifies leads. Untouched.
--   · `public.is_platform_admin()` — platform sees all tenants. Untouched.
--   · 'broker_admin' STAYS OUT of both branches. It is not a storable user_type
--     (users_user_type_check admits exactly: admin, agent, broker, broker_owner,
--     compliance_officer, contact, isa, lender, superadmin, support, system, tc,
--     team_lead, vendor) and it is not written to user_role_assignments either.
--     m308 removed it; re-adding it would restore dead weight that reads as
--     coverage.
--   · 'superadmin' STAYS in the user_type branch only, exactly as m308 left it —
--     it is the legacy marker for an account predating the platform_role column,
--     and is_platform_admin() reads it the same way. It is NOT re-added to the
--     grant branch, where it never was.
--   · SECURITY DEFINER + STABLE. Reading user_role_assignments inside a definer
--     function bypasses that table's own RLS, so this introduces no policy
--     recursion — the same reason the function can already read `users`.
--
-- 'isa' IS NOT ADDED HERE. The app roster carries the ISA seat, but the database
-- admits the ISA through its own arm, `is_ai_isa_system()`, which is how m308
-- and the owner's process describe it ("ai isa (system) follows up and qualifies
-- them"). Adding 'isa' to the role lists as well would be a second way to say
-- the same thing — the §6 defect — and would additionally admit a HUMAN seat
-- typed 'isa' through a branch written for the system actor. If a human ISA seat
-- ever needs lead rows in the database, that is its own ruling and its own arm.
--
-- NOT APPLIED BY THIS LANE. Files are not the database (CLAUDE.md §3); only the
-- integrator applies migrations. This adds no CHECK, so no vocabulary cache
-- needs regenerating.

CREATE OR REPLACE FUNCTION public.is_lead_visible_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    -- PRIMARY type. 'broker_admin' stays removed: the column cannot hold it.
    -- 'team_lead' ADDED (owner ruling above). BROKERAGE-WIDE at this level — the
    -- team narrowing is application-layer, see the honest-scope note in the
    -- header of this migration.
    COALESCE(
      (SELECT user_type IN ('broker', 'broker_owner', 'admin', 'team_lead', 'superadmin')
       FROM public.users WHERE id = auth.uid() LIMIT 1),
      FALSE
    )
    -- ASSIGNED roles (the RBAC table). A brokerage that grants someone broker,
    -- admin or TEAM LEAD through user_role_assignments has granted them the lead
    -- funnel. Adding team_lead to only one branch would have locked out the
    -- grant-held team lead — the same one-sidedness m308 existed to remove.
    OR EXISTS (
      SELECT 1 FROM public.user_role_assignments ura
      WHERE ura.user_id = auth.uid()
        AND ura.role IN ('broker', 'broker_owner', 'admin', 'team_lead')
    )
    -- The AI-ISA system actor: it follows up and qualifies leads. Unchanged.
    OR public.is_ai_isa_system()
    OR public.is_platform_admin();
$function$;

COMMENT ON FUNCTION public.is_lead_visible_role() IS
  'May the current user see rows in `leads`? The owner''s process: platform and brokerage roles see LEADS; the AI-ISA system actor qualifies them; once a lead shows positive intent it becomes a CONTACT assigned to an agent, and agents see contacts only — never leads. Reads BOTH role sources (users.user_type AND user_role_assignments), because a user may hold a role by assignment without it being their primary type. m308 dropped ''broker_admin'', a value users.user_type has never admitted. m518 added ''team_lead'' to BOTH branches on the owner''s ruling that a team-tier subscription has no broker, so the team lead sees leads. SCOPE WARNING: this predicate takes no row and therefore admits team_lead BROKERAGE-WIDE; "teams see only their own board" is enforced in the APPLICATION layer by lib/auth/lead-visibility.ts (LeadRowScope + applyLeadRowScope), which pins reads to the team''s agents via teams.team_lead_id. A query that reaches `leads` without that resolver is scoped only to the brokerage.';
