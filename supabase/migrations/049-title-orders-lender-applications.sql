-- =====================================================
-- MIGRATION 049: title_orders + lender_applications
-- =====================================================
-- Both are partner-OS feature tables used by /app/title and /app/lender
-- (and the partner-status panels in /app/dashboard/partners). Today every
-- SELECT against them returns empty because the tables don't exist.
--
-- Tenancy: both tables are brokerage-scoped. The title vendor /
-- lender vendor is captured via vendor_id (FK→vendors); the brokerage
-- that owns the deal scope is brokerage_id (NOT NULL).
-- =====================================================

-- ─── title_orders ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.title_orders (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  vendor_id        UUID        REFERENCES public.vendors(id) ON DELETE SET NULL,
  transaction_id   UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  property_address TEXT,
  closing_date     DATE,
  status           TEXT        NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  CONSTRAINT title_orders_status_check CHECK (status IN (
    'pending','ordered','in_progress','clear','issue','exception','completed','cancelled'
  ))
);

CREATE INDEX IF NOT EXISTS idx_title_orders_brokerage_created
  ON public.title_orders (brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_title_orders_vendor_status
  ON public.title_orders (vendor_id, status) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_title_orders_closing_date
  ON public.title_orders (closing_date) WHERE closing_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_title_orders_status_open
  ON public.title_orders (brokerage_id, status)
  WHERE status IN ('pending','ordered','in_progress','issue','exception');

ALTER TABLE public.title_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY title_orders_select ON public.title_orders FOR SELECT
  USING (
    public.is_platform_admin()
    OR public.has_brokerage_access(brokerage_id)
  );

CREATE POLICY title_orders_insert ON public.title_orders FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id())
  );

CREATE POLICY title_orders_update ON public.title_orders FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id())
  );

CREATE POLICY title_orders_delete ON public.title_orders FOR DELETE
  USING (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  );

-- ─── lender_applications ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lender_applications (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  lender_id        UUID        REFERENCES public.vendors(id) ON DELETE SET NULL,
  contact_id       UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  transaction_id   UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lender_applications_status_check CHECK (status IN (
    'pending','docs_needed','pre_approval','pre_approved',
    'processing','underwriting','approved','active',
    'denied','closed','cancelled'
  ))
);

CREATE INDEX IF NOT EXISTS idx_lender_applications_brokerage_updated
  ON public.lender_applications (brokerage_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lender_applications_lender_status
  ON public.lender_applications (lender_id, status) WHERE lender_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lender_applications_status_open
  ON public.lender_applications (brokerage_id, status)
  WHERE status IN ('pending','docs_needed','pre_approval','processing','underwriting');

ALTER TABLE public.lender_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY lender_applications_select ON public.lender_applications FOR SELECT
  USING (
    public.is_platform_admin()
    OR public.has_brokerage_access(brokerage_id)
  );

CREATE POLICY lender_applications_insert ON public.lender_applications FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id())
  );

CREATE POLICY lender_applications_update ON public.lender_applications FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id())
  );

CREATE POLICY lender_applications_delete ON public.lender_applications FOR DELETE
  USING (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  );
