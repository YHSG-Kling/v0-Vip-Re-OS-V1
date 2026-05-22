-- Vendor messaging lane for the unified communication spine.
-- The unified inbox (lib/kernel/communications.ts loadUniversalInbox) aggregates
-- multiple source tables at read time; this adds a dedicated vendor lane rather
-- than overloading client_portal_messages (whose contact_id/agent_id are NOT NULL
-- and whose direction CHECK is contact/agent-only). Polymorphic counterparty
-- supports both vendor<->contact and vendor<->agent threads.

CREATE TABLE IF NOT EXISTS public.vendor_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  vendor_id         uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  counterparty_type text NOT NULL CHECK (counterparty_type IN ('contact','agent')),
  counterparty_id   uuid NOT NULL,
  sender_type       text NOT NULL CHECK (sender_type IN ('vendor','contact','agent')),
  contact_vendor_id uuid REFERENCES public.contact_vendors(id) ON DELETE SET NULL,
  channel           text NOT NULL DEFAULT 'vendor',
  body              text NOT NULL,
  read              boolean NOT NULL DEFAULT false,
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_messages_sender_consistent
    CHECK (sender_type = 'vendor' OR sender_type = counterparty_type)
);

CREATE INDEX IF NOT EXISTS idx_vendor_messages_brokerage   ON public.vendor_messages(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_vendor_messages_vendor      ON public.vendor_messages(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_messages_counterparty ON public.vendor_messages(counterparty_type, counterparty_id, created_at DESC);

ALTER TABLE public.vendor_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY vendor_messages_select ON public.vendor_messages FOR SELECT
USING (
  public.is_platform_admin()
  OR public.has_brokerage_access(brokerage_id)
  OR vendor_id IN (
    SELECT ura.vendor_id FROM public.user_role_assignments ura
    WHERE ura.user_id = auth.uid() AND ura.vendor_id IS NOT NULL
  )
);

CREATE POLICY vendor_messages_insert ON public.vendor_messages FOR INSERT
WITH CHECK (
  public.is_platform_admin()
  OR public.has_brokerage_access(brokerage_id)
  OR vendor_id IN (
    SELECT ura.vendor_id FROM public.user_role_assignments ura
    WHERE ura.user_id = auth.uid() AND ura.vendor_id IS NOT NULL
  )
);

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
    -- the row's brokerage_id must remain the vendor's own brokerage
    AND brokerage_id = (SELECT v.brokerage_id FROM public.vendors v WHERE v.id = vendor_id)
  )
);

CREATE POLICY vendor_messages_delete ON public.vendor_messages FOR DELETE
USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
