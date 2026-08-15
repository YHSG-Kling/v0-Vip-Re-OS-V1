-- =====================================================
-- MIGRATION 055: showings + seller-portal tables
-- =====================================================
-- Seven tables across showing logistics, AI prediction output, and the
-- seller portal feed. All silently failed before this. Shapes verified
-- from real INSERT/SELECT callsites in:
--   • app/actions/ai-showing-management.ts (showing_communications,
--     showing_routes)
--   • app/actions/ai-predictions.ts (smart_showing_recommendations)
--   • app/actions/ai-calendar-management.ts (meeting_briefs)
--   • app/actions/push-listing-to-seller-portal.ts (seller_share_feed)
--   • app/portal/[contactId]/listing/page.tsx + seller-showing-sentiment.ts
--     (seller_updates)
--   • app/actions/listings.ts (seller_weekly_reports)
-- =====================================================

-- ─── showing_communications ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.showing_communications (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_id          UUID        NOT NULL REFERENCES public.showing_requests(id) ON DELETE CASCADE,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  communication_type  TEXT        NOT NULL,
  email_content       JSONB,
  sms_content         TEXT,
  status              TEXT        NOT NULL DEFAULT 'queued',
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT showing_communications_type_check CHECK (communication_type IN (
    'confirmation','reminder','feedback','cancellation','reschedule'
  )),
  CONSTRAINT showing_communications_status_check CHECK (status IN (
    'queued','sent','failed'
  ))
);
CREATE INDEX IF NOT EXISTS idx_showing_communications_showing
  ON public.showing_communications (showing_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.showing_communications_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.showing_requests WHERE id = NEW.showing_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS showing_communications_set_brokerage_trg ON public.showing_communications;
CREATE TRIGGER showing_communications_set_brokerage_trg BEFORE INSERT ON public.showing_communications
  FOR EACH ROW EXECUTE FUNCTION public.showing_communications_set_brokerage();

ALTER TABLE public.showing_communications ENABLE ROW LEVEL SECURITY;
CREATE POLICY showing_communications_select ON public.showing_communications FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY showing_communications_insert ON public.showing_communications FOR INSERT WITH CHECK (TRUE);
CREATE POLICY showing_communications_update ON public.showing_communications FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY showing_communications_delete ON public.showing_communications FOR DELETE USING (public.is_platform_admin());

-- ─── showing_routes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.showing_routes (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id         UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  route_date           DATE        NOT NULL,
  showings             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  optimized_order      JSONB,
  total_duration       INTEGER,
  estimated_miles      NUMERIC(8,2),
  optimization_score   NUMERIC(5,2),
  route_notes          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_showing_routes_agent_date ON public.showing_routes (agent_id, route_date DESC);
CREATE INDEX IF NOT EXISTS idx_showing_routes_brokerage_date ON public.showing_routes (brokerage_id, route_date DESC) WHERE brokerage_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.showing_routes_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS showing_routes_set_brokerage_trg ON public.showing_routes;
CREATE TRIGGER showing_routes_set_brokerage_trg BEFORE INSERT ON public.showing_routes
  FOR EACH ROW EXECUTE FUNCTION public.showing_routes_set_brokerage();

ALTER TABLE public.showing_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY showing_routes_select ON public.showing_routes FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY showing_routes_insert ON public.showing_routes FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_lead_visible_role());
CREATE POLICY showing_routes_update ON public.showing_routes FOR UPDATE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_brokerage_admin());
CREATE POLICY showing_routes_delete ON public.showing_routes FOR DELETE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── smart_showing_recommendations ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.smart_showing_recommendations (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 UUID        REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id              UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id            UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  recommended_properties  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  showing_route           JSONB,
  total_drive_time        NUMERIC(8,2),
  suggested_order         JSONB,
  recommended_day         DATE,
  why_these_properties    TEXT,
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT smart_showing_recommendations_target_check CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_smart_showing_recommendations_lead ON public.smart_showing_recommendations (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_smart_showing_recommendations_contact ON public.smart_showing_recommendations (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_smart_showing_recommendations_brokerage ON public.smart_showing_recommendations (brokerage_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.smart_showing_recommendations_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.lead_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id;
    ELSIF NEW.contact_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS smart_showing_recommendations_set_brokerage_trg ON public.smart_showing_recommendations;
CREATE TRIGGER smart_showing_recommendations_set_brokerage_trg BEFORE INSERT ON public.smart_showing_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.smart_showing_recommendations_set_brokerage();

ALTER TABLE public.smart_showing_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY smart_showing_recommendations_select ON public.smart_showing_recommendations FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY smart_showing_recommendations_insert ON public.smart_showing_recommendations FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR public.is_lead_visible_role());
CREATE POLICY smart_showing_recommendations_update ON public.smart_showing_recommendations FOR UPDATE USING (public.is_platform_admin() OR public.is_ai_isa_system() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR public.is_lead_visible_role());
CREATE POLICY smart_showing_recommendations_delete ON public.smart_showing_recommendations FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── meeting_briefs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meeting_briefs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  UUID        NOT NULL,
  agent_id        UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  brief_content   TEXT,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meeting_briefs_appt_agent_unique UNIQUE (appointment_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_briefs_agent ON public.meeting_briefs (agent_id, generated_at DESC);

CREATE OR REPLACE FUNCTION public.meeting_briefs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS meeting_briefs_set_brokerage_trg ON public.meeting_briefs;
CREATE TRIGGER meeting_briefs_set_brokerage_trg BEFORE INSERT ON public.meeting_briefs
  FOR EACH ROW EXECUTE FUNCTION public.meeting_briefs_set_brokerage();

ALTER TABLE public.meeting_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_briefs_select ON public.meeting_briefs FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY meeting_briefs_insert ON public.meeting_briefs FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_lead_visible_role());
CREATE POLICY meeting_briefs_update ON public.meeting_briefs FOR UPDATE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_brokerage_admin());
CREATE POLICY meeting_briefs_delete ON public.meeting_briefs FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── seller_share_feed ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seller_share_feed (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id            UUID        NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  contact_id            UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id          UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  pushed_by_user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  public_url            TEXT,
  share_messages        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  agent_note            TEXT,
  pushed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seller_share_feed_contact ON public.seller_share_feed (contact_id, pushed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_share_feed_brokerage ON public.seller_share_feed (brokerage_id, created_at DESC);

ALTER TABLE public.seller_share_feed ENABLE ROW LEVEL SECURITY;
CREATE POLICY seller_share_feed_select ON public.seller_share_feed FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = seller_share_feed.contact_id AND c.contact_user_id = auth.uid()));
CREATE POLICY seller_share_feed_insert ON public.seller_share_feed FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY seller_share_feed_update ON public.seller_share_feed FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR (brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY seller_share_feed_delete ON public.seller_share_feed FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── seller_updates ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seller_updates (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    UUID        REFERENCES public.listings(id) ON DELETE CASCADE,
  contact_id    UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id  UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  subject       TEXT,
  body          TEXT,
  video_url     TEXT,
  thumbnail_url TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seller_updates_contact_created ON public.seller_updates (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_updates_listing_created ON public.seller_updates (listing_id, created_at DESC) WHERE listing_id IS NOT NULL;

ALTER TABLE public.seller_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY seller_updates_select ON public.seller_updates FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = seller_updates.contact_id AND c.contact_user_id = auth.uid()));
CREATE POLICY seller_updates_insert ON public.seller_updates FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY seller_updates_update ON public.seller_updates FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR (brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY seller_updates_delete ON public.seller_updates FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── seller_weekly_reports ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seller_weekly_reports (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id          UUID        NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  contact_id          UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  report_week_start   DATE        NOT NULL,
  report_content      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seller_weekly_reports_listing_week_unique UNIQUE (listing_id, report_week_start)
);
CREATE INDEX IF NOT EXISTS idx_seller_weekly_reports_listing_week ON public.seller_weekly_reports (listing_id, report_week_start DESC);
CREATE INDEX IF NOT EXISTS idx_seller_weekly_reports_contact ON public.seller_weekly_reports (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;

ALTER TABLE public.seller_weekly_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY seller_weekly_reports_select ON public.seller_weekly_reports FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = seller_weekly_reports.contact_id AND c.contact_user_id = auth.uid())));
CREATE POLICY seller_weekly_reports_insert ON public.seller_weekly_reports FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR public.is_lead_visible_role());
CREATE POLICY seller_weekly_reports_update ON public.seller_weekly_reports FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR (brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY seller_weekly_reports_delete ON public.seller_weekly_reports FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
