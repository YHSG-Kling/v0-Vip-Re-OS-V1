-- =====================================================
-- MIGRATION 062: long-tail batch #3 — 21 missing tables
-- =====================================================
-- Captured by diffing every .from("...") ref against information_schema
-- (after m060 and m061 shipped) and reading each caller's INSERT shape.
-- =====================================================

-- ─── vendor_communications ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_communications (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  vendor_id           UUID        REFERENCES public.vendors(id) ON DELETE CASCADE,
  service_id          UUID        REFERENCES public.listing_marketing_services(id) ON DELETE SET NULL,
  communication_type  TEXT        NOT NULL,
  channel             TEXT,
  direction           TEXT,
  subject             TEXT,
  body                TEXT,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vc_vendor ON public.vendor_communications (vendor_id, sent_at DESC) WHERE vendor_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.vendor_communications_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL AND NEW.vendor_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.vendors WHERE id = NEW.vendor_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vendor_communications_set_brokerage_trg ON public.vendor_communications;
CREATE TRIGGER vendor_communications_set_brokerage_trg BEFORE INSERT ON public.vendor_communications FOR EACH ROW EXECUTE FUNCTION public.vendor_communications_set_brokerage();
ALTER TABLE public.vendor_communications ENABLE ROW LEVEL SECURITY;
CREATE POLICY vc_select ON public.vendor_communications FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY vc_insert ON public.vendor_communications FOR INSERT WITH CHECK (TRUE);
CREATE POLICY vc_update ON public.vendor_communications FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY vc_delete ON public.vendor_communications FOR DELETE USING (public.is_platform_admin());

-- ─── user_brokerage_roles ────────────────────────────────────────────────────
-- Maps auth users to brokerage role assignments. Distinct from user_roles
-- and user_role_assignments which already exist; this is the join the
-- permissions-client code expects with `roles(name, role_capabilities(...))`.
CREATE TABLE IF NOT EXISTS public.user_brokerage_roles (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  role_id       UUID,
  is_primary    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_brokerage_roles_unique UNIQUE (user_id, brokerage_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_ubr_user_primary ON public.user_brokerage_roles (user_id, is_primary) WHERE is_primary = TRUE;
ALTER TABLE public.user_brokerage_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY ubr_select ON public.user_brokerage_roles FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ubr_insert ON public.user_brokerage_roles FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY ubr_update ON public.user_brokerage_roles FOR UPDATE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY ubr_delete ON public.user_brokerage_roles FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── social_media_analytics ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_media_analytics (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  post_id           UUID        REFERENCES public.social_posts(id) ON DELETE CASCADE,
  platform          TEXT        NOT NULL,
  external_post_id  TEXT,
  published_at      TIMESTAMPTZ,
  impressions       INTEGER     NOT NULL DEFAULT 0,
  engagements       INTEGER     NOT NULL DEFAULT 0,
  clicks            INTEGER     NOT NULL DEFAULT 0,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  measured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sma_post ON public.social_media_analytics (post_id, measured_at DESC) WHERE post_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.social_media_analytics_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL AND NEW.post_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.social_posts WHERE id = NEW.post_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS social_media_analytics_set_brokerage_trg ON public.social_media_analytics;
CREATE TRIGGER social_media_analytics_set_brokerage_trg BEFORE INSERT ON public.social_media_analytics FOR EACH ROW EXECUTE FUNCTION public.social_media_analytics_set_brokerage();
ALTER TABLE public.social_media_analytics ENABLE ROW LEVEL SECURITY;
CREATE POLICY sma_select ON public.social_media_analytics FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY sma_insert ON public.social_media_analytics FOR INSERT WITH CHECK (TRUE);
CREATE POLICY sma_update ON public.social_media_analytics FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY sma_delete ON public.social_media_analytics FOR DELETE USING (public.is_platform_admin());

-- ─── property_search_log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_search_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id          UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  lead_id             UUID        REFERENCES public.leads(id) ON DELETE SET NULL,
  query_text          TEXT,
  extracted_filters   JSONB,
  result_count        INTEGER,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_psl_contact ON public.property_search_log (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.property_search_log_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.contact_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    ELSIF NEW.lead_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS property_search_log_set_brokerage_trg ON public.property_search_log;
CREATE TRIGGER property_search_log_set_brokerage_trg BEFORE INSERT ON public.property_search_log FOR EACH ROW EXECUTE FUNCTION public.property_search_log_set_brokerage();
ALTER TABLE public.property_search_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY psl_select ON public.property_search_log FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY psl_insert ON public.property_search_log FOR INSERT WITH CHECK (TRUE);
CREATE POLICY psl_update ON public.property_search_log FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY psl_delete ON public.property_search_log FOR DELETE USING (public.is_platform_admin());

-- ─── property_consensus ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_consensus (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborative_search_id  UUID        NOT NULL REFERENCES public.collaborative_searches(id) ON DELETE CASCADE,
  property_id              UUID,
  avg_rating               NUMERIC(5,2),
  vote_count               INTEGER     NOT NULL DEFAULT 0,
  is_finalist              BOOLEAN     NOT NULL DEFAULT FALSE,
  consensus_notes          TEXT,
  metadata                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT property_consensus_unique UNIQUE (collaborative_search_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_search ON public.property_consensus (collaborative_search_id, avg_rating DESC);
ALTER TABLE public.property_consensus ENABLE ROW LEVEL SECURITY;
CREATE POLICY pc_select ON public.property_consensus FOR SELECT USING (TRUE);
CREATE POLICY pc_insert ON public.property_consensus FOR INSERT WITH CHECK (TRUE);
CREATE POLICY pc_update ON public.property_consensus FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY pc_delete ON public.property_consensus FOR DELETE USING (public.is_platform_admin());

-- ─── orchestrator_tasks ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.orchestrator_tasks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  task_type       TEXT        NOT NULL,
  scheduled_for   TIMESTAMPTZ,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'pending',
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT,
  executed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT orchestrator_tasks_status_check CHECK (status IN ('pending','running','completed','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_ot_scheduled ON public.orchestrator_tasks (status, scheduled_for) WHERE status = 'pending';
ALTER TABLE public.orchestrator_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY ot_select ON public.orchestrator_tasks FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ot_insert ON public.orchestrator_tasks FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ot_update ON public.orchestrator_tasks FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY ot_delete ON public.orchestrator_tasks FOR DELETE USING (public.is_platform_admin());

-- ─── lead_value_journey ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_value_journey (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                  UUID        NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id                UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  first_interaction_date      DATE,
  total_value_received        NUMERIC(14,2) NOT NULL DEFAULT 0,
  touchpoints_count           INTEGER     NOT NULL DEFAULT 0,
  tools_used                  TEXT[]      NOT NULL DEFAULT '{}',
  guides_downloaded           TEXT[]      NOT NULL DEFAULT '{}',
  time_to_conversion_days     INTEGER,
  conversion_value            NUMERIC(14,2),
  roi_multiple                NUMERIC(10,2),
  became_client               BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lvj_brokerage_value ON public.lead_value_journey (brokerage_id, total_value_received DESC) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.lead_value_journey_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lead_value_journey_set_brokerage_trg ON public.lead_value_journey;
CREATE TRIGGER lead_value_journey_set_brokerage_trg BEFORE INSERT ON public.lead_value_journey FOR EACH ROW EXECUTE FUNCTION public.lead_value_journey_set_brokerage();
ALTER TABLE public.lead_value_journey ENABLE ROW LEVEL SECURITY;
CREATE POLICY lvj_select ON public.lead_value_journey FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY lvj_insert ON public.lead_value_journey FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lvj_update ON public.lead_value_journey FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY lvj_delete ON public.lead_value_journey FOR DELETE USING (public.is_platform_admin());

-- NOTE: idx_property_interactions and lead_idx_property_interactions
-- already exist in the live schema with their own contact_id/lead_id
-- column layouts. lib/actions/lead-intelligence.ts:876 writes the wrong
-- column names (`property_mls_id` instead of `mls_number`,
-- `time_spent_seconds` instead of `view_duration_seconds`,
-- `interacted_at` instead of `occurred_at`) and targets the wrong table.
-- That is a caller bug fixed in a separate commit, not a schema change.

-- ─── demo_persona_contacts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.demo_persona_contacts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  persona     TEXT        NOT NULL UNIQUE,
  contact_id  UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.demo_persona_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY dpc_select ON public.demo_persona_contacts FOR SELECT USING (TRUE);
CREATE POLICY dpc_insert ON public.demo_persona_contacts FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY dpc_update ON public.demo_persona_contacts FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY dpc_delete ON public.demo_persona_contacts FOR DELETE USING (public.is_platform_admin());

-- ─── contact_enrichment_queue ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_enrichment_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id      UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  source          TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending',
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_enrichment_queue_status_check CHECK (status IN ('pending','running','completed','failed','skipped'))
);
CREATE INDEX IF NOT EXISTS idx_ceq_pending ON public.contact_enrichment_queue (status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ceq_contact ON public.contact_enrichment_queue (contact_id);
ALTER TABLE public.contact_enrichment_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY ceq_select ON public.contact_enrichment_queue FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR public.is_ai_isa_system());
CREATE POLICY ceq_insert ON public.contact_enrichment_queue FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ceq_update ON public.contact_enrichment_queue FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR public.is_ai_isa_system()) WITH CHECK (TRUE);
CREATE POLICY ceq_delete ON public.contact_enrichment_queue FOR DELETE USING (public.is_platform_admin());

-- ─── appointments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.appointments (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id           UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  contact_id         UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  listing_id         UUID        REFERENCES public.listings(id) ON DELETE SET NULL,
  scheduled_at       TIMESTAMPTZ NOT NULL,
  duration_minutes   INTEGER,
  appointment_type   TEXT,
  status             TEXT        NOT NULL DEFAULT 'scheduled',
  property_address   TEXT,
  property_city      TEXT,
  property_state     TEXT,
  property_zip       TEXT,
  notes              TEXT,
  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointments_status_check CHECK (status IN ('scheduled','confirmed','completed','cancelled','no_show'))
);
CREATE INDEX IF NOT EXISTS idx_appts_scheduled ON public.appointments (brokerage_id, scheduled_at) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appts_agent ON public.appointments (agent_id, scheduled_at) WHERE agent_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.appointments_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.agent_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    ELSIF NEW.contact_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS appointments_set_brokerage_trg ON public.appointments;
CREATE TRIGGER appointments_set_brokerage_trg BEFORE INSERT ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.appointments_set_brokerage();
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY appts_select ON public.appointments FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY appts_insert ON public.appointments FOR INSERT WITH CHECK (TRUE);
CREATE POLICY appts_update ON public.appointments FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())) WITH CHECK (TRUE);
CREATE POLICY appts_delete ON public.appointments FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── document_downloads ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_downloads (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    UUID        NOT NULL,
  brokerage_id   UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  partner_id     UUID,
  partner_type   TEXT,
  user_id        UUID,
  ip_address     TEXT,
  user_agent     TEXT,
  downloaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dd_document ON public.document_downloads (document_id, downloaded_at DESC);
ALTER TABLE public.document_downloads ENABLE ROW LEVEL SECURITY;
CREATE POLICY dd_select ON public.document_downloads FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR user_id = auth.uid());
CREATE POLICY dd_insert ON public.document_downloads FOR INSERT WITH CHECK (TRUE);
CREATE POLICY dd_update ON public.document_downloads FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY dd_delete ON public.document_downloads FOR DELETE USING (public.is_platform_admin());

-- ─── document_requests ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  transaction_id  UUID        REFERENCES public.transactions(id) ON DELETE CASCADE,
  contact_id      UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  document_name   TEXT        NOT NULL,
  document_type   TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending',
  due_date        TIMESTAMPTZ,
  requested_by    UUID,
  fulfilled_at    TIMESTAMPTZ,
  fulfillment_url TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_requests_status_check CHECK (status IN ('pending','submitted','approved','rejected','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_dr_tx ON public.document_requests (transaction_id, status) WHERE transaction_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.document_requests_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL AND NEW.transaction_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.transaction_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS document_requests_set_brokerage_trg ON public.document_requests;
CREATE TRIGGER document_requests_set_brokerage_trg BEFORE INSERT ON public.document_requests FOR EACH ROW EXECUTE FUNCTION public.document_requests_set_brokerage();
ALTER TABLE public.document_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY dr_select ON public.document_requests FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY dr_insert ON public.document_requests FOR INSERT WITH CHECK (TRUE);
CREATE POLICY dr_update ON public.document_requests FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY dr_delete ON public.document_requests FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── document_retention ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_retention (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id                 UUID        NOT NULL UNIQUE,
  retention_category          TEXT,
  retention_years             INTEGER,
  transaction_close_date      DATE,
  delete_after_date           DATE,
  brokerage_id                UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drt_delete_after ON public.document_retention (delete_after_date) WHERE delete_after_date IS NOT NULL;
ALTER TABLE public.document_retention ENABLE ROW LEVEL SECURITY;
CREATE POLICY drt_select ON public.document_retention FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY drt_insert ON public.document_retention FOR INSERT WITH CHECK (TRUE);
CREATE POLICY drt_update ON public.document_retention FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY drt_delete ON public.document_retention FOR DELETE USING (public.is_platform_admin());

-- ─── contact_segments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_segments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  segment_id    UUID        NOT NULL,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_segments_unique UNIQUE (contact_id, segment_id)
);
CREATE INDEX IF NOT EXISTS idx_cs_segment ON public.contact_segments (segment_id, added_at DESC);
CREATE OR REPLACE FUNCTION public.contact_segments_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contact_segments_set_brokerage_trg ON public.contact_segments;
CREATE TRIGGER contact_segments_set_brokerage_trg BEFORE INSERT ON public.contact_segments FOR EACH ROW EXECUTE FUNCTION public.contact_segments_set_brokerage();
ALTER TABLE public.contact_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_segments_select ON public.contact_segments FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY contact_segments_insert ON public.contact_segments FOR INSERT WITH CHECK (TRUE);
CREATE POLICY contact_segments_update ON public.contact_segments FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY contact_segments_delete ON public.contact_segments FOR DELETE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));

-- ─── contact_portal_preferences ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_portal_preferences (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id             UUID        NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id           UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  milestone_overrides    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  notification_settings  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION public.contact_portal_preferences_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contact_portal_preferences_set_brokerage_trg ON public.contact_portal_preferences;
CREATE TRIGGER contact_portal_preferences_set_brokerage_trg BEFORE INSERT ON public.contact_portal_preferences FOR EACH ROW EXECUTE FUNCTION public.contact_portal_preferences_set_brokerage();
ALTER TABLE public.contact_portal_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpp_select ON public.contact_portal_preferences FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_portal_preferences.contact_id AND c.contact_user_id = auth.uid()));
CREATE POLICY cpp_insert ON public.contact_portal_preferences FOR INSERT WITH CHECK (TRUE);
CREATE POLICY cpp_update ON public.contact_portal_preferences FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY cpp_delete ON public.contact_portal_preferences FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── social_accounts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id       UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  platform       TEXT        NOT NULL,
  account_name   TEXT,
  external_id    TEXT,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     TIMESTAMPTZ,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sa_brokerage_platform ON public.social_accounts (brokerage_id, platform) WHERE brokerage_id IS NOT NULL;
ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sa_select ON public.social_accounts FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY sa_insert ON public.social_accounts FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY sa_update ON public.social_accounts FOR UPDATE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY sa_delete ON public.social_accounts FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── agent_monthly_earnings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_monthly_earnings (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  month_year          TEXT        NOT NULL,
  gross_total         NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  transaction_count   INTEGER     NOT NULL DEFAULT 0,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_monthly_earnings_unique UNIQUE (agent_id, month_year)
);
CREATE INDEX IF NOT EXISTS idx_ame_brokerage_month ON public.agent_monthly_earnings (brokerage_id, month_year DESC) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.agent_monthly_earnings_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_monthly_earnings_set_brokerage_trg ON public.agent_monthly_earnings;
CREATE TRIGGER agent_monthly_earnings_set_brokerage_trg BEFORE INSERT ON public.agent_monthly_earnings FOR EACH ROW EXECUTE FUNCTION public.agent_monthly_earnings_set_brokerage();
ALTER TABLE public.agent_monthly_earnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY ame_select ON public.agent_monthly_earnings FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ame_insert ON public.agent_monthly_earnings FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ame_update ON public.agent_monthly_earnings FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY ame_delete ON public.agent_monthly_earnings FOR DELETE USING (public.is_platform_admin());

-- ─── lead_external_behavior ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_external_behavior (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                     UUID        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  brokerage_id                UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  source                      TEXT        NOT NULL,
  activity_type               TEXT,
  property_addresses_viewed   TEXT[]      NOT NULL DEFAULT '{}',
  search_criteria_json        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  detected_via_zenrows        BOOLEAN     NOT NULL DEFAULT FALSE,
  metadata                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leb_lead ON public.lead_external_behavior (lead_id, created_at DESC);
CREATE OR REPLACE FUNCTION public.lead_external_behavior_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lead_external_behavior_set_brokerage_trg ON public.lead_external_behavior;
CREATE TRIGGER lead_external_behavior_set_brokerage_trg BEFORE INSERT ON public.lead_external_behavior FOR EACH ROW EXECUTE FUNCTION public.lead_external_behavior_set_brokerage();
ALTER TABLE public.lead_external_behavior ENABLE ROW LEVEL SECURITY;
CREATE POLICY leb_select ON public.lead_external_behavior FOR SELECT USING (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY leb_insert ON public.lead_external_behavior FOR INSERT WITH CHECK (TRUE);
CREATE POLICY leb_update ON public.lead_external_behavior FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY leb_delete ON public.lead_external_behavior FOR DELETE USING (public.is_platform_admin());

-- ─── lead_conversation_history ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_conversation_history (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  brokerage_id      UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  conversation_id   UUID,
  channel           TEXT,
  direction         TEXT,
  message_content   TEXT,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lch_lead ON public.lead_conversation_history (lead_id, occurred_at DESC);
CREATE OR REPLACE FUNCTION public.lead_conversation_history_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lead_conversation_history_set_brokerage_trg ON public.lead_conversation_history;
CREATE TRIGGER lead_conversation_history_set_brokerage_trg BEFORE INSERT ON public.lead_conversation_history FOR EACH ROW EXECUTE FUNCTION public.lead_conversation_history_set_brokerage();
ALTER TABLE public.lead_conversation_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY lch_select ON public.lead_conversation_history FOR SELECT USING (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY lch_insert ON public.lead_conversation_history FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lch_update ON public.lead_conversation_history FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY lch_delete ON public.lead_conversation_history FOR DELETE USING (public.is_platform_admin());

-- ─── communications ──────────────────────────────────────────────────────────
-- Unified comms log used by the GDPR data-subject-request export bundle.
-- Distinct from message_provider_logs (provider-level), transaction_communications
-- (transaction-scoped), and client_portal_messages (portal-only).
CREATE TABLE IF NOT EXISTS public.communications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id      UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  agent_id        UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  channel         TEXT        NOT NULL,
  direction       TEXT        NOT NULL,
  subject         TEXT,
  content_preview TEXT,
  contact_email   TEXT,
  to_email        TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT communications_direction_check CHECK (direction IN ('inbound','outbound'))
);
CREATE INDEX IF NOT EXISTS idx_comm_contact ON public.communications (contact_id, sent_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comm_brokerage ON public.communications (brokerage_id, sent_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comm_email ON public.communications (contact_email) WHERE contact_email IS NOT NULL;
CREATE OR REPLACE FUNCTION public.communications_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.contact_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    ELSIF NEW.agent_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS communications_set_brokerage_trg ON public.communications;
CREATE TRIGGER communications_set_brokerage_trg BEFORE INSERT ON public.communications FOR EACH ROW EXECUTE FUNCTION public.communications_set_brokerage();
ALTER TABLE public.communications ENABLE ROW LEVEL SECURITY;
CREATE POLICY comm_select ON public.communications FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY comm_insert ON public.communications FOR INSERT WITH CHECK (TRUE);
CREATE POLICY comm_update ON public.communications FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY comm_delete ON public.communications FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
