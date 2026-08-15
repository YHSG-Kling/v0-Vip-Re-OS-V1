-- =====================================================
-- MIGRATION 035: raw_scraped_leads is platform-owned
-- =====================================================
-- Today the table has FIVE active policies, two of which are wrong:
--
--   1. "Brokers and admins view raw leads" — reads `users.role`
--      (legacy column) and lets brokerage admins SELECT all raw rows.
--   2. "System insert raw leads"           — `WITH CHECK (true)`.
--   3. raw_scraped_leads_tenant_select     — also allows
--      `brokerage_id IS NULL` to be visible to ANY brokerage user.
--      Since platform-owned rows are stored with brokerage_id NULL
--      until they are routed/promoted, this leaks the entire
--      pre-routing intake to every tenant.
--   4/5. raw_scraped_leads_tenant_insert / update / delete — same
--        `brokerage_id IS NULL OR …` leak on the write paths.
--
-- Product intent (user-confirmed): `raw_scraped_leads` is
-- PLATFORM-OWNED. The scraper / pipeline keeps trying to promote
-- raw rows into `leads` until every gate clears. Brokerage users
-- (including broker_owner) MUST NOT see raw rows. Only:
--   - the platform admin (read everything), and
--   - the per-brokerage AI-ISA system actor (read its own brokerage's
--     targeted raw rows during pipeline retries).
--
-- Also adds `promotion_attempts` so retries are visible to ops.
-- =====================================================

-- Drop every existing policy, the legacy ones first.
DROP POLICY IF EXISTS "Brokers and admins view raw leads" ON public.raw_scraped_leads;
DROP POLICY IF EXISTS "System insert raw leads"           ON public.raw_scraped_leads;
DROP POLICY IF EXISTS raw_scraped_leads_tenant_select     ON public.raw_scraped_leads;
DROP POLICY IF EXISTS raw_scraped_leads_tenant_insert     ON public.raw_scraped_leads;
DROP POLICY IF EXISTS raw_scraped_leads_tenant_update     ON public.raw_scraped_leads;
DROP POLICY IF EXISTS raw_scraped_leads_tenant_delete     ON public.raw_scraped_leads;

-- Add promotion_attempts (idempotent).
ALTER TABLE public.raw_scraped_leads
  ADD COLUMN IF NOT EXISTS promotion_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_promotion_attempt_at TIMESTAMPTZ;

-- SELECT: platform admin reads everything; ISA reads its own brokerage
-- (including platform-owned rows that have been routed to it).
CREATE POLICY raw_scraped_leads_select ON public.raw_scraped_leads
  FOR SELECT
  USING (
    public.is_platform_admin()
    OR (public.is_ai_isa_system()
        AND (brokerage_id IS NULL OR brokerage_id = public.current_user_brokerage_id()))
  );

-- INSERT: only the scraper actors (platform admin via cron, or ISA system).
CREATE POLICY raw_scraped_leads_insert ON public.raw_scraped_leads
  FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_ai_isa_system()
        AND (brokerage_id IS NULL OR brokerage_id = public.current_user_brokerage_id()))
  );

-- UPDATE: same as INSERT.
CREATE POLICY raw_scraped_leads_update ON public.raw_scraped_leads
  FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (public.is_ai_isa_system()
        AND (brokerage_id IS NULL OR brokerage_id = public.current_user_brokerage_id()))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_ai_isa_system()
        AND (brokerage_id IS NULL OR brokerage_id = public.current_user_brokerage_id()))
  );

-- DELETE: platform admin only.
CREATE POLICY raw_scraped_leads_delete ON public.raw_scraped_leads
  FOR DELETE
  USING (public.is_platform_admin());

ALTER TABLE public.raw_scraped_leads ENABLE ROW LEVEL SECURITY;
