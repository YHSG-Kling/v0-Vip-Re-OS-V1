-- =====================================================
-- MIGRATION 052: email_sends + email_tracking + drip_campaigns
--                + automation_logs
-- =====================================================
-- Four tables backing email-campaign execution, drip nurture flows,
-- and the automation trigger log. All missing; verified caller shapes:
--   • app/actions/email-campaigns.ts          (email_sends)
--   • app/actions/ai-lead-nurturing.ts        (email_tracking)
--   • app/actions/workflows.ts                (drip_campaigns)
--   • app/actions/assistant.ts                (automation_logs)
-- =====================================================

-- ─── email_sends ─────────────────────────────────────────────────────────────
-- Per-recipient row queued from a parent email_campaigns row.
CREATE TABLE IF NOT EXISTS public.email_sends (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID        REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  contact_id      UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'queued',
  scheduled_for   TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  error_message   TEXT,
  provider_message_id TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_sends_status_check CHECK (status IN (
    'queued','sending','sent','failed','bounced','cancelled'
  ))
);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON public.email_sends (campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_contact ON public.email_sends (contact_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_status ON public.email_sends (status);
CREATE INDEX IF NOT EXISTS idx_email_sends_brokerage ON public.email_sends (brokerage_id) WHERE brokerage_id IS NOT NULL;

-- Auto-denormalize brokerage_id from parent campaign
CREATE OR REPLACE FUNCTION public.email_sends_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL AND NEW.campaign_id IS NOT NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.email_campaigns WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS email_sends_set_brokerage_trg ON public.email_sends;
CREATE TRIGGER email_sends_set_brokerage_trg BEFORE INSERT ON public.email_sends
  FOR EACH ROW EXECUTE FUNCTION public.email_sends_set_brokerage();

ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_sends_select ON public.email_sends FOR SELECT
  USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY email_sends_insert ON public.email_sends FOR INSERT
  WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR public.is_lead_visible_role());
CREATE POLICY email_sends_update ON public.email_sends FOR UPDATE
  USING (public.is_platform_admin() OR public.is_ai_isa_system() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)))
  WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR public.is_lead_visible_role());
CREATE POLICY email_sends_delete ON public.email_sends FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── email_tracking ──────────────────────────────────────────────────────────
-- Engagement events (open / click / bounce / unsubscribe / complaint).
CREATE TABLE IF NOT EXISTS public.email_tracking (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_send_id UUID        REFERENCES public.email_sends(id) ON DELETE CASCADE,
  contact_id    UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,
  url           TEXT,
  user_agent    TEXT,
  ip_address    TEXT,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  event_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_tracking_event_check CHECK (event_type IN (
    'sent','delivered','open','click','bounce','spam_complaint','unsubscribe','dropped','deferred'
  ))
);
CREATE INDEX IF NOT EXISTS idx_email_tracking_contact ON public.email_tracking (contact_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_tracking_send ON public.email_tracking (email_send_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_type ON public.email_tracking (event_type, event_at DESC);

ALTER TABLE public.email_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_tracking_select ON public.email_tracking FOR SELECT
  USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY email_tracking_insert ON public.email_tracking FOR INSERT
  WITH CHECK (TRUE); -- provider webhooks may have no auth context; gate at app layer.
CREATE POLICY email_tracking_update ON public.email_tracking FOR UPDATE
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY email_tracking_delete ON public.email_tracking FOR DELETE
  USING (public.is_platform_admin());

-- ─── drip_campaigns ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.drip_campaigns (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id      UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  brokerage_id  UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  drip_type     TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT drip_campaigns_status_check CHECK (status IN (
    'active','paused','completed','cancelled'
  ))
);
CREATE INDEX IF NOT EXISTS idx_drip_campaigns_contact ON public.drip_campaigns (contact_id);
CREATE INDEX IF NOT EXISTS idx_drip_campaigns_agent ON public.drip_campaigns (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drip_campaigns_brokerage_active ON public.drip_campaigns (brokerage_id, status) WHERE status = 'active';

ALTER TABLE public.drip_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY drip_campaigns_select ON public.drip_campaigns FOR SELECT
  USING (
    public.is_platform_admin()
    OR public.has_brokerage_access(brokerage_id)
    OR (public.is_agent_role() AND agent_id IS NOT NULL AND agent_id = public.current_user_agent_id())
  );
CREATE POLICY drip_campaigns_insert ON public.drip_campaigns FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (brokerage_id = public.current_user_brokerage_id())
  );
CREATE POLICY drip_campaigns_update ON public.drip_campaigns FOR UPDATE
  USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id))
  WITH CHECK (public.is_platform_admin() OR (brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY drip_campaigns_delete ON public.drip_campaigns FOR DELETE
  USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── automation_logs ─────────────────────────────────────────────────────────
-- One row per automation trigger fire. user_id is the actor whose
-- automation rule fired; brokerage_id denormalized from that user.
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID,
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  trigger_type  TEXT,
  result        JSONB,
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_user ON public.automation_logs (user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_logs_brokerage ON public.automation_logs (brokerage_id, executed_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON public.automation_logs (automation_id) WHERE automation_id IS NOT NULL;

-- Auto-denormalize brokerage_id from user
CREATE OR REPLACE FUNCTION public.automation_logs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.users WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS automation_logs_set_brokerage_trg ON public.automation_logs;
CREATE TRIGGER automation_logs_set_brokerage_trg BEFORE INSERT ON public.automation_logs
  FOR EACH ROW EXECUTE FUNCTION public.automation_logs_set_brokerage();

ALTER TABLE public.automation_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY automation_logs_select ON public.automation_logs FOR SELECT
  USING (
    public.is_platform_admin()
    OR (user_id = auth.uid())
    OR (brokerage_id IS NOT NULL AND public.has_brokerage_access(brokerage_id))
  );
CREATE POLICY automation_logs_insert ON public.automation_logs FOR INSERT
  WITH CHECK (TRUE); -- automation system writes from trigger flows
CREATE POLICY automation_logs_update ON public.automation_logs FOR UPDATE
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY automation_logs_delete ON public.automation_logs FOR DELETE
  USING (public.is_platform_admin());
