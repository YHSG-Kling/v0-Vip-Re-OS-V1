-- =====================================================
-- MIGRATION 047: client_portal_activity
-- =====================================================
-- Six places in the app (app/actions/contact-details.ts,
-- journey-tasks.ts, showings.ts, collaborative-search.ts, portal-seller.ts)
-- write to a `client_portal_activity` table that does not exist. Every
-- portal-side write (task completed, task form submitted, showing
-- requested, portal module viewed, collaborative-search interaction)
-- is silently dropped; the SELECT in contact-details that aggregates
-- a contact's activity feed gets no rows.
--
-- Existing tables don't fit cleanly:
--   - portal_access_logs uses (module_key, action) — designed for
--     module-view tracking, not arbitrary activity events.
--   - portal_event_stream requires agent_copy NOT NULL — designed for
--     two-way agent/customer event surfacing, not raw activity log.
--
-- Schema below matches the callers' actual shape. Compatibility note:
-- callers were writing `activity_data` while the SELECT reads `metadata`.
-- This migration standardizes on `metadata` (matches the rest of the
-- schema). Callers are updated in the same change.
-- =====================================================

CREATE TABLE IF NOT EXISTS public.client_portal_activity (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id    UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id      UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  property_id   UUID,  -- loose ref; not all activity targets a listing row
  activity_type TEXT        NOT NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_portal_activity_contact_created
  ON public.client_portal_activity (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_portal_activity_brokerage_created
  ON public.client_portal_activity (brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_portal_activity_type
  ON public.client_portal_activity (activity_type);

ALTER TABLE public.client_portal_activity ENABLE ROW LEVEL SECURITY;

-- SELECT
--   - platform admin: everything
--   - brokerage admin / lead-visible roles: brokerage scope
--   - agent: only activity for contacts they own (agents.id match)
--   - contact (self-portal user): only their own activity
CREATE POLICY client_portal_activity_select ON public.client_portal_activity
  FOR SELECT
  USING (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id))
    OR (
      public.is_agent_role()
      AND agent_id IS NOT NULL
      AND agent_id = public.current_user_agent_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = client_portal_activity.contact_id
        AND c.contact_user_id = auth.uid()
    )
  );

-- INSERT
--   - any actor in the brokerage may write activity for their own
--     contacts; the ISA system actor + platform admin can write anywhere
--     in their scope.
CREATE POLICY client_portal_activity_insert ON public.client_portal_activity
  FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_ai_isa_system() AND brokerage_id = public.current_user_brokerage_id())
    OR (
      brokerage_id = public.current_user_brokerage_id()
      AND EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.id = client_portal_activity.contact_id
          AND c.brokerage_id = client_portal_activity.brokerage_id
      )
    )
    OR EXISTS (
      -- self-portal user can record their own activity
      SELECT 1 FROM public.contacts c
      WHERE c.id = client_portal_activity.contact_id
        AND c.contact_user_id = auth.uid()
    )
  );

-- UPDATE / DELETE: platform + brokerage admins only — activity is
-- generally append-only.
CREATE POLICY client_portal_activity_update ON public.client_portal_activity
  FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  );

CREATE POLICY client_portal_activity_delete ON public.client_portal_activity
  FOR DELETE
  USING (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  );
