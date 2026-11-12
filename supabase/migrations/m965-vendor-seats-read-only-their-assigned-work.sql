-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151B ──
--
-- S4 (OWNER DECISION, wave 151 directive §151B): "Vendors see only the Contacts, listings, transactions, assignments and
-- documents specifically authorized for their assigned work. Additional vendor visibility may exist under an explicitly
-- authorized subscription plan or contractual entitlement. That plan never overrides tenant isolation or unrelated customer
-- permissions." Lenders are vendors (vendors.category 'lender' / 'refinance_lender'; lib/kernel/lender-linkage.ts) and
-- "see only assigned, authorized deals".
--
-- WHAT ALREADY HELD (measured live 2026-11-09, kept — not rewritten):
--   contacts.contacts_vendor_scoped_read     = current_user_type() = 'vendor' AND vendor_has_contact_access(id)
--   transactions.transactions_vendor_scoped_read = current_user_type() = 'vendor' AND vendor_has_transaction_access(id)
--   both helpers: an ACTIVE, unexpired vendor_contact_assignments row for the caller's vendor, OR the EXISTING entitlement
--   vocabulary vendors.access_level = 'brokerage_full_access' pinned to the SAME tenant as the row (vendors_access_level_check:
--   transaction_only | team_full_access | brokerage_full_access). That IS the "explicitly authorized entitlement" the ruling
--   names — a column the brokerage sets on the vendor row, never a billing object — and it never crosses the tenant line.
--   vendor_bookings_vendor_read_own / vca_vendor_read_own / vbq_vendor_read_own / vendor_messages / vendor_* finance rows:
--   own-vendor reads through user_role_assignments.vendor_id.
--
-- WHAT DID NOT HOLD — the ASSIGNMENT and DOCUMENT surfaces were tenant-wide for EVERY authenticated seat of the tenant, so a
-- vendor (or contact) seat read every other vendor's assignments / bookings / contact grants and every document:
--   vendor_assignments_tenant_select / _update / _delete   (brokerage_id = current_user_brokerage_id())
--   vendor_bookings.vb_brokerage (ALL)                      (brokerage_id = current_user_brokerage_id())
--   vendor_contact_assignments.vca_tenant_read              (brokerage_id = current_user_brokerage_id()) OR is_platform_admin()
--   documents_tenant_select / _update / _delete             (brokerage_id = current_user_brokerage_id())
-- and the LENDER gate (lib/kernel/portal-auth.ts requireLenderVendorActor, lib/kernel/lender-linkage.ts
-- linkLenderVendorToTransaction) anchors on vendor_assignments, which vendor_has_transaction_access() never read — a lender
-- assigned through the lender rail had NO session read on its own deal (the §4 "successfully EMPTY" shape).
--
-- THE RULE: tenant STAFF seats keep the tenant-wide read / write they had; a vendor seat reads ITS OWN vendor's rows and the
-- documents of deals it is assigned to; a contact seat reads documents that name its own contact; a vendor writes only its own
-- bookings (accept / decline / complete — app/actions/vendor-portal.ts, app/actions/vendor-marketplace.ts markBookingComplete).
-- Policies on PUBLIC tables, ALTER / CREATE POLICY and CREATE OR REPLACE FUNCTION: MCP-applicable, one statement per call.

-- 1. vendor_has_transaction_access(): the lender rail's vendor_assignments is an assignment too (status not cancelled).
CREATE OR REPLACE FUNCTION public.vendor_has_transaction_access(p_transaction_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH v AS (
    SELECT vendor_id FROM public.user_role_assignments
     WHERE user_id = auth.uid() AND vendor_id IS NOT NULL LIMIT 1
  ),
  ven AS (
    SELECT id, brokerage_id, access_level FROM public.vendors WHERE id = (SELECT vendor_id FROM v)
  ),
  t AS (SELECT brokerage_id FROM public.transactions WHERE id = p_transaction_id)
  SELECT p_transaction_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.vendor_contact_assignments vca
       WHERE vca.transaction_id = p_transaction_id
         AND vca.vendor_id = (SELECT vendor_id FROM v)
         AND vca.status = 'active'
         AND (vca.expires_at IS NULL OR vca.expires_at > now())
    )
    OR EXISTS (
      SELECT 1 FROM public.vendor_assignments va
       WHERE va.transaction_id = p_transaction_id
         AND va.vendor_id = (SELECT vendor_id FROM v)
         AND va.status IS DISTINCT FROM 'cancelled'
         AND va.brokerage_id = (SELECT brokerage_id FROM t)
    )
    OR (
      (SELECT access_level FROM ven) = 'brokerage_full_access'
      AND (SELECT brokerage_id FROM ven) = (SELECT brokerage_id FROM t)
    )
  )
$function$;

-- 2. vendor_assignments: staff read the tenant's; a vendor seat reads its own vendor's; only staff write.
ALTER POLICY vendor_assignments_tenant_select ON public.vendor_assignments
  USING (
    (brokerage_id = public.current_user_brokerage_id())
    AND (public.is_tenant_staff_seat() OR public.is_current_user_vendor(vendor_id))
  );
ALTER POLICY vendor_assignments_tenant_update ON public.vendor_assignments
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat())
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY vendor_assignments_tenant_delete ON public.vendor_assignments
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());

-- 3. vendor_bookings: the tenant-wide ALL policy becomes a STAFF policy; a vendor keeps its own read (existing policy) and
--    gains its own UPDATE (accept / decline / complete), pinned to its vendor and its tenant on both sides.
ALTER POLICY vb_brokerage ON public.vendor_bookings
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat())
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
DROP POLICY IF EXISTS vendor_bookings_vendor_update_own ON public.vendor_bookings;
CREATE POLICY vendor_bookings_vendor_update_own ON public.vendor_bookings
  FOR UPDATE TO authenticated
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_current_user_vendor(vendor_id))
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_current_user_vendor(vendor_id));

-- 4. vendor_contact_assignments: the tenant-wide read becomes staff (+ platform admin); vca_vendor_read_own stays the vendor's.
ALTER POLICY vca_tenant_read ON public.vendor_contact_assignments
  USING (
    ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat())
    OR public.is_platform_admin()
  );

-- 5. documents: staff tenant-wide; a contact its own contact's documents; a vendor the documents of deals it is assigned to
--    (vendor_assignments, or a vendor_contact_assignments grant / the brokerage_full_access entitlement, same tenant).
ALTER POLICY documents_tenant_select ON public.documents
  USING (
    (brokerage_id = public.current_user_brokerage_id())
    AND (
      public.is_tenant_staff_seat()
      OR ((contact_id IS NOT NULL) AND public.is_self_contact(contact_id))
      OR ((transaction_id IS NOT NULL) AND public.current_user_type() = 'vendor'
          AND (public.is_assigned_vendor_on_transaction(transaction_id) OR public.vendor_has_transaction_access(transaction_id)))
    )
  );
ALTER POLICY documents_tenant_update ON public.documents
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat())
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY documents_tenant_delete ON public.documents
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());

-- NOT CHANGED, STATED: vendors_tenant_select ((brokerage_id IS NULL) OR tenant) is the bench / directory every tenant seat
-- browses (platform rows carry NULL by design — vendors_global_not_curated); listing_media_tenant_select stays tenant-wide
-- (the bucket is public marketing media); transaction_documents already gates by party (document_party_on_deal) and is
-- untouched; vendors.access_level 'team_full_access' is NOT read by either helper today (it narrows to assigned — the safe
-- direction) and widening it is a product decision recorded in the lane notes, not taken here.
--
-- READ-BACK (integrator, after apply):
--   SELECT tablename, policyname, cmd, regexp_replace(coalesce(qual,''), '\s+', ' ', 'g')
--     FROM pg_policies WHERE schemaname = 'public'
--      AND tablename IN ('vendor_assignments','vendor_bookings','vendor_contact_assignments','documents')
--    ORDER BY 1, 2;
--   → every tenant-wide read / write arm now carries is_tenant_staff_seat(); the vendor arms name is_current_user_vendor /
--     is_assigned_vendor_on_transaction / vendor_has_transaction_access; vendor_bookings_vendor_update_own exists.
--   SELECT pg_get_functiondef('public.vendor_has_transaction_access(uuid)'::regprocedure);  → names vendor_assignments.
