-- Harden the vendor_messages UPDATE policy: add an explicit WITH CHECK so a
-- vendor cannot relocate a row into another tenant by changing brokerage_id.
-- Without WITH CHECK, Postgres reuses USING for the new row, which would let a
-- vendor set an arbitrary brokerage_id as long as vendor_id stayed theirs.
DROP POLICY IF EXISTS vendor_messages_update ON public.vendor_messages;

CREATE POLICY vendor_messages_update ON public.vendor_messages FOR UPDATE
USING (
  public.is_platform_admin()
  OR public.has_brokerage_access(brokerage_id)
  OR vendor_id IN (
    SELECT ura.vendor_id FROM public.user_role_assignments ura
    WHERE ura.user_id = auth.uid() AND ura.vendor_id IS NOT NULL
  )
)
WITH CHECK (
  public.is_platform_admin()
  OR public.has_brokerage_access(brokerage_id)
  OR (
    vendor_id IN (
      SELECT ura.vendor_id FROM public.user_role_assignments ura
      WHERE ura.user_id = auth.uid() AND ura.vendor_id IS NOT NULL
    )
    AND brokerage_id = (SELECT v.brokerage_id FROM public.vendors v WHERE v.id = vendor_id)
  )
);
