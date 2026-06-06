-- =====================================================
-- MIGRATION 056: workflow_step_executions + cma_packages +
--                video_content + listing_inquiries
-- =====================================================
-- Four discrete missing tables. Distinct from existing analogues:
--   • workflow_step_executions ≠ workflow_step_runs
--       step_runs is the campaign-sequence step log (channel,
--       conversion_value_cents, attribution_source). step_executions
--       is the orchestrator's runtime log (action_type / params /
--       result jsonb, retry_count) — different concept.
--   • cma_packages ≠ cma_reports (job tracker vs report content)
--   • video_content ≠ video_projects / video_content_queue
--       (simpler library row for copilot.ts social scheduler)
--   • listing_inquiries: public lead-capture form INSERT target
--       (listings page form at /listings/[listingId])
-- =====================================================

-- ─── workflow_step_executions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workflow_step_executions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    UUID        REFERENCES public.workflow_executions(id) ON DELETE CASCADE,
  step_id         TEXT,
  step_name       TEXT,
  action_type     TEXT,
  params          JSONB,
  status          TEXT        NOT NULL DEFAULT 'pending',
  result          JSONB,
  error_message   TEXT,
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT workflow_step_executions_status_check CHECK (status IN (
    'pending','running','completed','failed','skipped','cancelled'
  ))
);
CREATE INDEX IF NOT EXISTS idx_workflow_step_executions_exec ON public.workflow_step_executions (execution_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_step_executions_status ON public.workflow_step_executions (status) WHERE status IN ('pending','running','failed');

ALTER TABLE public.workflow_step_executions ENABLE ROW LEVEL SECURITY;
-- Tenancy via the parent workflow_executions row's brokerage_id (no need to
-- denormalize since this is an internal orchestrator log).
CREATE POLICY workflow_step_executions_select ON public.workflow_step_executions FOR SELECT
  USING (
    public.is_platform_admin()
    OR (execution_id IS NULL)
    OR EXISTS (
      SELECT 1 FROM public.workflow_executions we
      WHERE we.id = workflow_step_executions.execution_id
        AND (we.brokerage_id IS NULL OR public.has_brokerage_access(we.brokerage_id))
    )
  );
CREATE POLICY workflow_step_executions_insert ON public.workflow_step_executions FOR INSERT
  WITH CHECK (TRUE); -- orchestrator writes from many contexts
CREATE POLICY workflow_step_executions_update ON public.workflow_step_executions FOR UPDATE
  USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY workflow_step_executions_delete ON public.workflow_step_executions FOR DELETE
  USING (public.is_platform_admin());

-- ─── cma_packages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cma_packages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID,
  agent_id      UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  brokerage_id  UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  status        TEXT        NOT NULL DEFAULT 'generating',
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cma_packages_status_check CHECK (status IN (
    'generating','ready','error','cancelled'
  ))
);
CREATE INDEX IF NOT EXISTS idx_cma_packages_property ON public.cma_packages (property_id, created_at DESC) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cma_packages_agent ON public.cma_packages (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cma_packages_brokerage ON public.cma_packages (brokerage_id, created_at DESC);

ALTER TABLE public.cma_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY cma_packages_select ON public.cma_packages FOR SELECT
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY cma_packages_insert ON public.cma_packages FOR INSERT
  WITH CHECK (public.is_platform_admin() OR (brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY cma_packages_update ON public.cma_packages FOR UPDATE
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()))
  WITH CHECK (public.is_platform_admin() OR brokerage_id = public.current_user_brokerage_id());
CREATE POLICY cma_packages_delete ON public.cma_packages FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── video_content ───────────────────────────────────────────────────────────
-- Simpler library distinct from video_projects (render pipeline) and
-- video_content_queue (HeyGen async queue). Source row is just a video
-- asset the agent's social scheduler picks from.
CREATE TABLE IF NOT EXISTS public.video_content (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  title           TEXT,
  video_url       TEXT,
  thumbnail_url   TEXT,
  source          TEXT,
  duration_sec    NUMERIC(10,2),
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_content_agent ON public.video_content (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_content_brokerage ON public.video_content (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.video_content_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS video_content_set_brokerage_trg ON public.video_content;
CREATE TRIGGER video_content_set_brokerage_trg BEFORE INSERT ON public.video_content
  FOR EACH ROW EXECUTE FUNCTION public.video_content_set_brokerage();

ALTER TABLE public.video_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY video_content_select ON public.video_content FOR SELECT
  USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY video_content_insert ON public.video_content FOR INSERT
  WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_lead_visible_role());
CREATE POLICY video_content_update ON public.video_content FOR UPDATE
  USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_brokerage_admin());
CREATE POLICY video_content_delete ON public.video_content FOR DELETE
  USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── listing_inquiries ───────────────────────────────────────────────────────
-- Public form INSERT target (no auth required at insert; gated by listing
-- visibility / token where applicable). brokerage_id auto-denormalized.
CREATE TABLE IF NOT EXISTS public.listing_inquiries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    UUID        NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  message       TEXT,
  source        TEXT        NOT NULL DEFAULT 'public_listing_page',
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_listing ON public.listing_inquiries (listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_inquiries_brokerage ON public.listing_inquiries (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.listing_inquiries_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.listings WHERE id = NEW.listing_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS listing_inquiries_set_brokerage_trg ON public.listing_inquiries;
CREATE TRIGGER listing_inquiries_set_brokerage_trg BEFORE INSERT ON public.listing_inquiries
  FOR EACH ROW EXECUTE FUNCTION public.listing_inquiries_set_brokerage();

ALTER TABLE public.listing_inquiries ENABLE ROW LEVEL SECURITY;
CREATE POLICY listing_inquiries_select ON public.listing_inquiries FOR SELECT
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY listing_inquiries_insert ON public.listing_inquiries FOR INSERT
  WITH CHECK (TRUE); -- public capture form, anon allowed
CREATE POLICY listing_inquiries_update ON public.listing_inquiries FOR UPDATE
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id))
  WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY listing_inquiries_delete ON public.listing_inquiries FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
