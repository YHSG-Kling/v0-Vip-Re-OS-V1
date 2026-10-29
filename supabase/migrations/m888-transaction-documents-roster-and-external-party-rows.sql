-- WRITTEN, NOT APPLIED (wave 146, lane 146Z) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m888 — THE DEAL-DOCUMENT ROW ADMITS THE TENANT ROSTER, AND AN ASSIGNED VENDOR / LENDER / TITLE PARTY
--         CAN FILE (AND READ BACK) ITS OWN DOCUMENT ON THE DEAL IT IS ASSIGNED TO
--         (wave 146, lane 146Z — lane 146A Still open 3 + 4 / Outside-lane 5 + 6; owner ruling 20 priority 1)
--
-- PUBLIC SCHEMA ONLY (two new boolean helpers + ALTER POLICY + CREATE POLICY on public.transaction_documents) —
-- the integrator CAN apply it (WAVE146_SPEC "Public-table policies the integrator CAN apply"). It builds on m874's
-- functions (public.document_staff_on_transaction, public.document_external_party_on_transaction — both live since
-- m874, 2026-10-29) and REFUSES TO START without them. No table, column, CHECK or FK is added: no cache regeneration.
--
-- 1. THE ROSTER (Still open 4). Live (pg_policies, read 2026-10-29):
--      trx_broker_transaction_documents  ALL  USING/WITH CHECK (brokerage_id = current_user_brokerage_id()
--        AND current_user_type() = ANY (ARRAY['broker','admin','super_admin','tc']))
--    It misses broker_owner, broker_admin and compliance_officer (CLAUDE.md §4 TENANT_ADMIN_USER_TYPES) and names
--    'super_admin', which is not a storable users.user_type; m875 admits the roster to the BUCKET, so a broker_owner
--    could store a deal file whose ROW was refused. Replaced by the ONE staff predicate m874 already defines for the
--    bucket (document_staff_on_transaction: the oversight class minus team_lead, the TC, the deal's own agents and
--    the lead of their team, on an ACTIVE seat of the deal's brokerage) — row and bucket answer the same question.
--    A deal-less row (transaction_id IS NULL — e.g. a listing document) keeps the class that read it before (the
--    oversight class + the TC of the brokerage), widened to the roster spellings the old list missed.
--
-- 2. THE EXTERNAL PARTIES (Still open 3). No policy admitted a vendor, lender or title seat on transaction_documents,
--    so their portal uploads stored (m875 admits their own sub-folder) and then the ROW insert was refused and the
--    compensation removed the file — the vendor / lender / title portals were broken at the row level
--    (app/actions/title-portal.ts, app/actions/lender-portal-actions.ts, app/actions/vendor-portal.ts). The party
--    files ONLY on a deal it is assigned to (document_external_party_on_transaction — vendor_assignments /
--    title_company_users, a lender / title VENDOR CATEGORY per CLAUDE.md §4, never a user_type), only as itself
--    (uploaded_by = auth.uid()), only into the deal's own tenant, and reads back only what it filed (plus a CDA
--    delivered to that title user). It never reads the rest of the deal file.
--    This is a GRANT: the integrator reviews it before applying (lane 146A flagged it "owner / integrator review").
--    Live: 0 transaction_documents rows, 0 title_company_users, 0 vendor_assignments (2026-10-29).
--
-- VERIFY AFTER APPLYING
--   SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'transaction_documents' ORDER BY policyname;
--     → trx_broker_transaction_documents names document_staff_on_transaction and no 'super_admin';
--       transaction_documents_party_insert (INSERT) and transaction_documents_party_select (SELECT) exist.
--   SELECT to_regprocedure('public.document_deal_in_tenant(uuid, uuid)'), to_regprocedure('public.document_party_on_deal(uuid)');
-- ROLLBACK (re-opens nothing; restores the narrower roster and removes the party grant)
--   ALTER POLICY trx_broker_transaction_documents ON public.transaction_documents
--     USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker','admin','super_admin','tc'])))
--     WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker','admin','super_admin','tc'])));
--   DROP POLICY IF EXISTS transaction_documents_party_insert ON public.transaction_documents;
--   DROP POLICY IF EXISTS transaction_documents_party_select ON public.transaction_documents;

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.document_staff_on_transaction(uuid)') IS NULL
     OR to_regprocedure('public.document_external_party_on_transaction(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'm888 needs m874 (document_staff_on_transaction / document_external_party_on_transaction) applied first';
  END IF;
END $$;

-- The deal's tenant, read past RLS (a vendor seat cannot read public.transactions for every deal it may file on);
-- a BOOLEAN, so it discloses nothing a caller did not already hold both halves of.
CREATE OR REPLACE FUNCTION public.document_deal_in_tenant(p_transaction_id uuid, p_brokerage_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(p_transaction_id IS NOT NULL AND p_brokerage_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id = p_transaction_id AND t.brokerage_id = p_brokerage_id
  ), false);
$function$;

-- Any external party kind assigned to this deal (vendor / lender / title — m874's ONE party predicate, three kinds).
CREATE OR REPLACE FUNCTION public.document_party_on_deal(p_transaction_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(
    public.document_external_party_on_transaction(p_transaction_id, 'title')
    OR public.document_external_party_on_transaction(p_transaction_id, 'lender')
    OR public.document_external_party_on_transaction(p_transaction_id, 'vendor'),
  false);
$function$;

REVOKE ALL ON FUNCTION public.document_deal_in_tenant(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_party_on_deal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.document_deal_in_tenant(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_party_on_deal(uuid) TO authenticated, service_role;

-- 1. the roster — the bucket's staff predicate, row-side
ALTER POLICY trx_broker_transaction_documents ON public.transaction_documents
  USING (
    public.document_staff_on_transaction(transaction_id)
    OR (transaction_id IS NULL
        AND brokerage_id = public.current_user_brokerage_id()
        AND public.brokerage_forms_seat_active()
        AND ((public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead') OR public.is_tc_role()))
  )
  WITH CHECK (
    brokerage_id = public.current_user_brokerage_id()
    AND (
      public.document_staff_on_transaction(transaction_id)
      OR (transaction_id IS NULL
          AND public.brokerage_forms_seat_active()
          AND ((public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead') OR public.is_tc_role()))
    )
  );

-- 2. the external parties — file as themselves on an assigned deal, read back only their own (and a CDA delivered to them)
DROP POLICY IF EXISTS transaction_documents_party_insert ON public.transaction_documents;
CREATE POLICY transaction_documents_party_insert ON public.transaction_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND public.document_deal_in_tenant(transaction_id, brokerage_id)
    AND public.document_party_on_deal(transaction_id)
  );

DROP POLICY IF EXISTS transaction_documents_party_select ON public.transaction_documents;
CREATE POLICY transaction_documents_party_select ON public.transaction_documents
  FOR SELECT TO authenticated
  USING (
    public.document_party_on_deal(transaction_id)
    AND (uploaded_by = auth.uid()
         OR (doc_type = 'cda' AND metadata->>'delivered_to_title_user_id' = auth.uid()::text))
  );

COMMIT;
