-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149B ──
--
-- m938 — C28 COLLABORATIVE SEARCH: the buyer's say over the Shopping Agent, and a collaborator who sees ONLY the
-- shared homes.
--
-- 1. collaborative_searches.feedback_for_shopping_agent (+ _consent_at, _consent_by_user_id) — "Shopping Agent uses
--    [family opinions] only when the buyer says so" (C28). Default FALSE: silence is not consent.
--
-- 2. portal_member_searches() — live definition (2026-11-03) admitted ANY row whose collaborative_search_members.email
--    matched the caller's JWT email, pending or accepted, to SELECT the whole search (the buyer's search_criteria
--    included) and — through the member_write_* / member_update_* policies — to INSERT members and properties. C28's
--    scope is feedback_only: "No CRM, documents or other portal data for the collaborator." The collaborator now
--    reaches ONLY the shared homes through the token door (lib/portal/collaborative-share.ts collaboratorView, service
--    client, hash-matched, expiring, revocable). The function keeps the OWNER arm (the buyer, by their contact's email)
--    and the owner member row; invited members are no longer admitted through RLS.
--
-- 3. collaborative_searches tenant policies read `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`
--    — an unstamped row is every tenant's. The only writer stamps brokerage_id (app/actions/collaborative-search.ts,
--    lib/portal/collaborative-share.ts) and the table holds ZERO rows (live 2026-11-03), so the NULL arm is removed and
--    the column made NOT NULL.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts and scripts/schema-fk-map.ts.

ALTER TABLE public.collaborative_searches
  ADD COLUMN IF NOT EXISTS feedback_for_shopping_agent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS feedback_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS feedback_consent_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.collaborative_searches WHERE brokerage_id IS NULL) THEN
    ALTER TABLE public.collaborative_searches ALTER COLUMN brokerage_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'm938: unstamped collaborative_searches rows exist — NOT NULL skipped; stamp them from contacts.brokerage_id first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.portal_member_searches()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- searches the authenticated user OWNS (their contact row, by email). Invited collaborators (scope
  -- feedback_only) are NOT admitted here — they reach only the shared homes through the token door.
  SELECT s.id FROM collaborative_searches s
    JOIN contacts c ON c.id IN (s.contact_id, s.created_by_contact_id)
   WHERE lower(c.email) = lower(coalesce(auth.jwt()->>'email',''))
  UNION
  SELECT m.collaborative_search_id FROM collaborative_search_members m
   WHERE m.role = 'owner'
     AND lower(m.email) = lower(coalesce(auth.jwt()->>'email',''))
$function$;

DROP POLICY IF EXISTS collaborative_searches_tenant_select ON public.collaborative_searches;
CREATE POLICY collaborative_searches_tenant_select ON public.collaborative_searches
  FOR SELECT TO authenticated USING (brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS collaborative_searches_tenant_update ON public.collaborative_searches;
CREATE POLICY collaborative_searches_tenant_update ON public.collaborative_searches
  FOR UPDATE TO authenticated USING (brokerage_id = current_user_brokerage_id()) WITH CHECK (brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS collaborative_searches_tenant_delete ON public.collaborative_searches;
CREATE POLICY collaborative_searches_tenant_delete ON public.collaborative_searches
  FOR DELETE TO authenticated USING (brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS collaborative_searches_tenant_insert ON public.collaborative_searches;
CREATE POLICY collaborative_searches_tenant_insert ON public.collaborative_searches
  FOR INSERT TO public WITH CHECK (brokerage_id = current_user_brokerage_id() AND is_tenant_staff_seat());
