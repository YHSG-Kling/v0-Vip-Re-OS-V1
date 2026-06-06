-- =====================================================
-- MIGRATION 060: long-tail batch — 10 missing tables with real callers
-- =====================================================
-- Verified caller shapes from the parallel-agent long-tail audit.
-- All 10 have ≥3 active callsites. Each follows the established
-- pattern: brokerage_id-scoped where possible (auto-denormalize via
-- trigger from parent FK), RLS template = platform admin +
-- has_brokerage_access + (where applicable) agent self-access.
-- =====================================================

-- ─── value_delivered_daily ───────────────────────────────────────────────────
-- Daily "value delivered to clients" rollup. UPSERT keyed by
-- (agent_id, date) matches the analytics.ts upsert.
CREATE TABLE IF NOT EXISTS public.value_delivered_daily (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                        UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id                    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  date                            DATE        NOT NULL,
  total_value_delivered_dollars   NUMERIC(14,2) NOT NULL DEFAULT 0,
  recipients_count                INTEGER     NOT NULL DEFAULT 0,
  cost_to_deliver                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  value_breakdown                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT value_delivered_daily_unique UNIQUE (agent_id, date)
);
CREATE INDEX IF NOT EXISTS idx_value_delivered_daily_brokerage_date ON public.value_delivered_daily (brokerage_id, date DESC) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.value_delivered_daily_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS value_delivered_daily_set_brokerage_trg ON public.value_delivered_daily;
CREATE TRIGGER value_delivered_daily_set_brokerage_trg BEFORE INSERT ON public.value_delivered_daily FOR EACH ROW EXECUTE FUNCTION public.value_delivered_daily_set_brokerage();
ALTER TABLE public.value_delivered_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY value_delivered_daily_select ON public.value_delivered_daily FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY value_delivered_daily_insert ON public.value_delivered_daily FOR INSERT WITH CHECK (TRUE);
CREATE POLICY value_delivered_daily_update ON public.value_delivered_daily FOR UPDATE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY value_delivered_daily_delete ON public.value_delivered_daily FOR DELETE USING (public.is_platform_admin());

-- ─── saved_calculations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.saved_calculations (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name               TEXT        NOT NULL,
  visitor_id              TEXT,
  brokerage_id            UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  calculation_data_json   JSONB,
  user_email              TEXT,
  user_name               TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_calculations_visitor ON public.saved_calculations (visitor_id, created_at DESC) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saved_calculations_tool ON public.saved_calculations (tool_name, created_at DESC);
ALTER TABLE public.saved_calculations ENABLE ROW LEVEL SECURITY;
CREATE POLICY saved_calculations_select ON public.saved_calculations FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY saved_calculations_insert ON public.saved_calculations FOR INSERT WITH CHECK (TRUE);
CREATE POLICY saved_calculations_update ON public.saved_calculations FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY saved_calculations_delete ON public.saved_calculations FOR DELETE USING (public.is_platform_admin());

-- ─── property_interactions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_interactions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  listing_id        UUID        REFERENCES public.listings(id) ON DELETE CASCADE,
  brokerage_id      UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  interaction_type  TEXT        NOT NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT property_interactions_type_check CHECK (interaction_type IN (
    'view','save','share','favorite','inquiry','tour_request','offer','price_alert_click'
  ))
);
CREATE INDEX IF NOT EXISTS idx_property_interactions_listing_type ON public.property_interactions (listing_id, interaction_type, created_at DESC) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_property_interactions_contact ON public.property_interactions (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.property_interactions_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.listing_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.listings WHERE id = NEW.listing_id;
    ELSIF NEW.contact_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS property_interactions_set_brokerage_trg ON public.property_interactions;
CREATE TRIGGER property_interactions_set_brokerage_trg BEFORE INSERT ON public.property_interactions FOR EACH ROW EXECUTE FUNCTION public.property_interactions_set_brokerage();
ALTER TABLE public.property_interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY property_interactions_select ON public.property_interactions FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = property_interactions.contact_id AND c.contact_user_id = auth.uid()));
CREATE POLICY property_interactions_insert ON public.property_interactions FOR INSERT WITH CHECK (TRUE);
CREATE POLICY property_interactions_update ON public.property_interactions FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY property_interactions_delete ON public.property_interactions FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── property_family_ratings ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_family_ratings (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborative_search_id  UUID        NOT NULL REFERENCES public.collaborative_searches(id) ON DELETE CASCADE,
  property_id              UUID,
  member_email             TEXT,
  rating                   INTEGER,
  vote                     TEXT,
  pros                     TEXT[]      NOT NULL DEFAULT '{}',
  cons                     TEXT[]      NOT NULL DEFAULT '{}',
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT property_family_ratings_unique UNIQUE (collaborative_search_id, property_id, member_email),
  CONSTRAINT property_family_ratings_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_pfr_search_prop ON public.property_family_ratings (collaborative_search_id, property_id);
ALTER TABLE public.property_family_ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY property_family_ratings_select ON public.property_family_ratings FOR SELECT USING (TRUE);
CREATE POLICY property_family_ratings_insert ON public.property_family_ratings FOR INSERT WITH CHECK (TRUE);
CREATE POLICY property_family_ratings_update ON public.property_family_ratings FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY property_family_ratings_delete ON public.property_family_ratings FOR DELETE USING (public.is_platform_admin());

-- ─── message_access_control ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.message_access_control (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID        NOT NULL,
  user_id           UUID        NOT NULL,
  user_type         TEXT,
  can_read          BOOLEAN     NOT NULL DEFAULT TRUE,
  can_write         BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_by        UUID,
  expires_at        TIMESTAMPTZ,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT message_access_control_unique UNIQUE (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mac_conversation ON public.message_access_control (conversation_id);
ALTER TABLE public.message_access_control ENABLE ROW LEVEL SECURITY;
CREATE POLICY mac_select ON public.message_access_control FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid() OR granted_by = auth.uid());
CREATE POLICY mac_insert ON public.message_access_control FOR INSERT WITH CHECK (public.is_platform_admin() OR granted_by = auth.uid());
CREATE POLICY mac_update ON public.message_access_control FOR UPDATE USING (public.is_platform_admin() OR granted_by = auth.uid()) WITH CHECK (public.is_platform_admin() OR granted_by = auth.uid());
CREATE POLICY mac_delete ON public.message_access_control FOR DELETE USING (public.is_platform_admin() OR granted_by = auth.uid());

-- ─── lead_social_intelligence ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_social_intelligence (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                   UUID        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  brokerage_id              UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  source                    TEXT        NOT NULL,
  post_content              TEXT,
  post_url                  TEXT,
  author_name               TEXT,
  author_profile_url        TEXT,
  posted_date               TIMESTAMPTZ,
  detected_location         TEXT,
  intent_keywords_matched   TEXT[]      NOT NULL DEFAULT '{}',
  metadata                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lsi_lead ON public.lead_social_intelligence (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lsi_source ON public.lead_social_intelligence (source);
CREATE OR REPLACE FUNCTION public.lead_social_intelligence_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lead_social_intelligence_set_brokerage_trg ON public.lead_social_intelligence;
CREATE TRIGGER lead_social_intelligence_set_brokerage_trg BEFORE INSERT ON public.lead_social_intelligence FOR EACH ROW EXECUTE FUNCTION public.lead_social_intelligence_set_brokerage();
ALTER TABLE public.lead_social_intelligence ENABLE ROW LEVEL SECURITY;
CREATE POLICY lsi_select ON public.lead_social_intelligence FOR SELECT USING (public.is_platform_admin() OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY lsi_insert ON public.lead_social_intelligence FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lsi_update ON public.lead_social_intelligence FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY lsi_delete ON public.lead_social_intelligence FOR DELETE USING (public.is_platform_admin());

-- ─── document_sharing_links ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_sharing_links (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID        NOT NULL,
  share_token         TEXT        NOT NULL UNIQUE,
  shared_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  shared_with_email   TEXT,
  access_level        TEXT,
  requires_password   BOOLEAN     NOT NULL DEFAULT FALSE,
  password_hash       TEXT,
  expires_at          TIMESTAMPTZ,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dsl_document ON public.document_sharing_links (document_id);
CREATE INDEX IF NOT EXISTS idx_dsl_active ON public.document_sharing_links (is_active, expires_at) WHERE is_active = TRUE;
ALTER TABLE public.document_sharing_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY dsl_select ON public.document_sharing_links FOR SELECT USING (public.is_platform_admin() OR shared_by = auth.uid() OR (is_active AND share_token IS NOT NULL));
CREATE POLICY dsl_insert ON public.document_sharing_links FOR INSERT WITH CHECK (public.is_platform_admin() OR shared_by = auth.uid());
CREATE POLICY dsl_update ON public.document_sharing_links FOR UPDATE USING (public.is_platform_admin() OR shared_by = auth.uid()) WITH CHECK (public.is_platform_admin() OR shared_by = auth.uid());
CREATE POLICY dsl_delete ON public.document_sharing_links FOR DELETE USING (public.is_platform_admin() OR shared_by = auth.uid());

-- ─── document_audit_trail ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_audit_trail (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           UUID        NOT NULL,
  document_source       TEXT,
  action                TEXT        NOT NULL,
  performed_by          UUID,
  performed_by_type     TEXT,
  notes                 TEXT,
  ip_address            TEXT,
  user_agent            TEXT,
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dat_document ON public.document_audit_trail (document_id, created_at DESC);
ALTER TABLE public.document_audit_trail ENABLE ROW LEVEL SECURITY;
CREATE POLICY dat_select ON public.document_audit_trail FOR SELECT USING (public.is_platform_admin() OR performed_by = auth.uid());
CREATE POLICY dat_insert ON public.document_audit_trail FOR INSERT WITH CHECK (TRUE);
CREATE POLICY dat_update ON public.document_audit_trail FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY dat_delete ON public.document_audit_trail FOR DELETE USING (public.is_platform_admin());

-- ─── document_access_log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_access_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID        NOT NULL,
  accessed_by_type    TEXT,
  accessed_by_id      UUID,
  accessed_by_email   TEXT,
  access_type         TEXT,
  ip_address          TEXT,
  user_agent          TEXT,
  accessed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dal_document ON public.document_access_log (document_id, accessed_at DESC);
ALTER TABLE public.document_access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY dal_select ON public.document_access_log FOR SELECT USING (public.is_platform_admin() OR accessed_by_id = auth.uid());
CREATE POLICY dal_insert ON public.document_access_log FOR INSERT WITH CHECK (TRUE);
CREATE POLICY dal_update ON public.document_access_log FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY dal_delete ON public.document_access_log FOR DELETE USING (public.is_platform_admin());

-- ─── commission_splits ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commission_splits (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  transaction_id  UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  commission_id   UUID,
  agent_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  brokerage_amount NUMERIC(14,2),
  status          TEXT        NOT NULL DEFAULT 'pending',
  paid_at         TIMESTAMPTZ,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT commission_splits_status_check CHECK (status IN ('pending','approved','paid','disputed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_commission_splits_agent ON public.commission_splits (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_splits_brokerage ON public.commission_splits (brokerage_id, status) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.commission_splits_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS commission_splits_set_brokerage_trg ON public.commission_splits;
CREATE TRIGGER commission_splits_set_brokerage_trg BEFORE INSERT ON public.commission_splits FOR EACH ROW EXECUTE FUNCTION public.commission_splits_set_brokerage();
ALTER TABLE public.commission_splits ENABLE ROW LEVEL SECURITY;
CREATE POLICY commission_splits_select ON public.commission_splits FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY commission_splits_insert ON public.commission_splits FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_brokerage_admin());
CREATE POLICY commission_splits_update ON public.commission_splits FOR UPDATE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR public.is_brokerage_admin());
CREATE POLICY commission_splits_delete ON public.commission_splits FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
