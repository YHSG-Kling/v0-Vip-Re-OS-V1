-- m308 — the lead-visibility predicate named a phantom role and ignored the RBAC table.
-- ─────────────────────────────────────────────────────────────────────────────
-- THE BUSINESS PROCESS (owner, verbatim):
--
--   "platform and brokerages can only see leads and ai isa (system) follows up
--    and qualifies them. once the lead has positive intent, the lead gets
--    converted to a contact and assigned to an agent. the agent can only see
--    contacts."
--
-- That process IS built, and it is enforced here rather than in application code
-- — leads_select is `is_platform_admin() OR (is_lead_visible_role() AND
-- has_brokerage_access(brokerage_id))`, so an agent querying `leads` gets nothing
-- back no matter which surface asks. That is the right place for it.
--
-- Two defects in the predicate itself:
--
-- 1. IT NAMED 'broker_admin'. users.user_type has never admitted that value
--    (verified against users_user_type_check: admin, agent, broker, broker_owner,
--    compliance_officer, contact, isa, lender, superadmin, support, system, tc,
--    team_lead, vendor). So one third of the role list could never match. It read
--    like coverage and was dead weight — the same phantom-value class as the seat
--    list that once contained 'broker_admin' too, and the vendor category the
--    picker could never save.
--
-- 2. IT READ users.user_type ONLY. The OS assigns roles TWO ways and both are
--    real: user_type is the PRIMARY type, and user_role_assignments is the RBAC
--    table where a user may hold several roles. Live today: 7 assignments across
--    4 users, 2 users holding more than one role, 3 assignments disagreeing with
--    that user's user_type — and ONE user whose brokerage granted them broker /
--    broker_owner / admin by assignment while their primary type is something
--    else. That person is locked out of the lead funnel the brokerage explicitly
--    gave them access to.
--
--    This is the same under-count that made the seat meter wrong (fixed in
--    lib/kernel/seat-usage.ts), except here it is an ACCESS decision: there, a
--    wrong number; here, a real person who cannot do their job.
--
-- The fix reads BOTH sources, drops the phantom, and keeps everything else
-- identical: agents still see no leads, the AI-ISA system actor still does (it
-- qualifies them), and brokerage scoping still comes from has_brokerage_access.
--
-- SECURITY DEFINER + STABLE, as before. Reading user_role_assignments inside a
-- definer function bypasses that table's own RLS, so this introduces no policy
-- recursion — the same reason the existing function can read `users`.

CREATE OR REPLACE FUNCTION public.is_lead_visible_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    -- PRIMARY type. 'broker_admin' removed: the column cannot hold it.
    COALESCE(
      (SELECT user_type IN ('broker', 'broker_owner', 'admin', 'superadmin')
       FROM public.users WHERE id = auth.uid() LIMIT 1),
      FALSE
    )
    -- ASSIGNED roles (the RBAC table). A brokerage that grants someone broker or
    -- admin through user_role_assignments has granted them the lead funnel.
    OR EXISTS (
      SELECT 1 FROM public.user_role_assignments ura
      WHERE ura.user_id = auth.uid()
        AND ura.role IN ('broker', 'broker_owner', 'admin')
    )
    -- The AI-ISA system actor: it follows up and qualifies leads. Unchanged.
    OR public.is_ai_isa_system()
    OR public.is_platform_admin();
$function$;

COMMENT ON FUNCTION public.is_lead_visible_role() IS
  'May the current user see rows in `leads`? The owner''s process: platform and brokerage roles see LEADS; the AI-ISA system actor qualifies them; once a lead shows positive intent it becomes a CONTACT assigned to an agent, and agents see contacts only — never leads. Reads BOTH role sources (users.user_type AND user_role_assignments), because a user may hold a role by assignment without it being their primary type; reading user_type alone locked out users their brokerage had explicitly granted. m308 also dropped ''broker_admin'', a value users.user_type has never admitted.';
