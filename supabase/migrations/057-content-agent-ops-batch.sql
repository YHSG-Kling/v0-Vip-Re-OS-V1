-- =====================================================
-- MIGRATION 057: content + agent-ops batch (14 missing tables)
-- =====================================================
-- All 14 follow the established RLS + brokerage-trigger pattern.
-- Verified against agent-confirmed caller shapes.
-- =====================================================

-- ─── chat_templates ──────────────────────────────────────────────────────────
-- Chat-specific templates with usage_count, template_category,
-- allowed_lead_types, compliance_approved. Distinct from content_templates
-- (which lacks these chat-specific compliance + usage fields).
CREATE TABLE IF NOT EXISTS public.chat_templates (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id              UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  template_name         TEXT        NOT NULL,
  template_body         TEXT        NOT NULL,
  template_category     TEXT,
  allowed_lead_types    TEXT[],
  compliance_approved   BOOLEAN     NOT NULL DEFAULT FALSE,
  usage_count           INTEGER     NOT NULL DEFAULT 0,
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_templates_usage ON public.chat_templates (usage_count DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_chat_templates_category ON public.chat_templates (template_category) WHERE template_category IS NOT NULL;
ALTER TABLE public.chat_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_templates_select ON public.chat_templates FOR SELECT USING (TRUE);
CREATE POLICY chat_templates_insert ON public.chat_templates FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY chat_templates_update ON public.chat_templates FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())) WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY chat_templates_delete ON public.chat_templates FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── ai_suggestions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_suggestions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id            UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  suggestion_type     TEXT        NOT NULL,
  suggestion_content  TEXT,
  confidence_score    NUMERIC(5,4),
  was_accepted        BOOLEAN,
  accepted_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_session ON public.ai_suggestions (session_id, created_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_agent ON public.ai_suggestions (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_suggestions_select ON public.ai_suggestions FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY ai_suggestions_insert ON public.ai_suggestions FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ai_suggestions_update ON public.ai_suggestions FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY ai_suggestions_delete ON public.ai_suggestions FOR DELETE USING (public.is_platform_admin());

-- ─── content_generation_logs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_generation_logs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id          UUID,
  agent_id            UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  model_used          TEXT,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  total_tokens        INTEGER,
  cost_usd            NUMERIC(10,4),
  generation_time_ms  INTEGER,
  success             BOOLEAN     NOT NULL DEFAULT TRUE,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_generation_logs_agent ON public.content_generation_logs (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_generation_logs_brokerage ON public.content_generation_logs (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.content_generation_logs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_generation_logs_set_brokerage_trg ON public.content_generation_logs;
CREATE TRIGGER content_generation_logs_set_brokerage_trg BEFORE INSERT ON public.content_generation_logs FOR EACH ROW EXECUTE FUNCTION public.content_generation_logs_set_brokerage();
ALTER TABLE public.content_generation_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_generation_logs_select ON public.content_generation_logs FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY content_generation_logs_insert ON public.content_generation_logs FOR INSERT WITH CHECK (TRUE);
CREATE POLICY content_generation_logs_update ON public.content_generation_logs FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY content_generation_logs_delete ON public.content_generation_logs FOR DELETE USING (public.is_platform_admin());

-- ─── generated_documents ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.generated_documents (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id       UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  document_type  TEXT        NOT NULL,
  contact_id     UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  listing_id     UUID        REFERENCES public.listings(id) ON DELETE SET NULL,
  transaction_id UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  blob_url       TEXT,
  blob_id        TEXT,
  file_name      TEXT,
  file_size      BIGINT,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generated_documents_agent ON public.generated_documents (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_documents_contact ON public.generated_documents (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_documents_listing ON public.generated_documents (listing_id) WHERE listing_id IS NOT NULL;
ALTER TABLE public.generated_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY generated_documents_select ON public.generated_documents FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY generated_documents_insert ON public.generated_documents FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_lead_visible_role());
CREATE POLICY generated_documents_update ON public.generated_documents FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY generated_documents_delete ON public.generated_documents FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── template_marketplace + template_feedback ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.template_marketplace (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  author_user_id  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  template_name   TEXT        NOT NULL,
  template_type   TEXT        NOT NULL,
  template_body   TEXT,
  visibility      TEXT        NOT NULL DEFAULT 'brokerage_only',
  rating          NUMERIC(3,2),
  usage_count     INTEGER     NOT NULL DEFAULT 0,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT template_marketplace_visibility_check CHECK (visibility IN ('global','brokerage_only','private'))
);
CREATE INDEX IF NOT EXISTS idx_template_marketplace_brokerage ON public.template_marketplace (brokerage_id) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_template_marketplace_rating ON public.template_marketplace (rating DESC NULLS LAST);
ALTER TABLE public.template_marketplace ENABLE ROW LEVEL SECURITY;
CREATE POLICY template_marketplace_select ON public.template_marketplace FOR SELECT USING (visibility = 'global' OR public.is_platform_admin() OR (visibility = 'brokerage_only' AND public.has_brokerage_access(brokerage_id)) OR (visibility = 'private' AND author_user_id = auth.uid()));
CREATE POLICY template_marketplace_insert ON public.template_marketplace FOR INSERT WITH CHECK (public.is_platform_admin() OR (author_user_id = auth.uid() AND (brokerage_id IS NULL OR brokerage_id = public.current_user_brokerage_id())));
CREATE POLICY template_marketplace_update ON public.template_marketplace FOR UPDATE USING (public.is_platform_admin() OR author_user_id = auth.uid()) WITH CHECK (public.is_platform_admin() OR author_user_id = auth.uid());
CREATE POLICY template_marketplace_delete ON public.template_marketplace FOR DELETE USING (public.is_platform_admin() OR author_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.template_feedback (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID        NOT NULL REFERENCES public.template_marketplace(id) ON DELETE CASCADE,
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  rating        INTEGER,
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT template_feedback_rating_check CHECK (rating BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_template_feedback_template ON public.template_feedback (template_id, created_at DESC);
ALTER TABLE public.template_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY template_feedback_select ON public.template_feedback FOR SELECT USING (TRUE);
CREATE POLICY template_feedback_insert ON public.template_feedback FOR INSERT WITH CHECK (user_id IS NULL OR user_id = auth.uid());
CREATE POLICY template_feedback_update ON public.template_feedback FOR UPDATE USING (public.is_platform_admin() OR user_id = auth.uid()) WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY template_feedback_delete ON public.template_feedback FOR DELETE USING (public.is_platform_admin() OR user_id = auth.uid());

-- ─── signature_requests ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signature_requests (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID        REFERENCES public.transaction_documents(id) ON DELETE CASCADE,
  transaction_id    UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  contact_id        UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  brokerage_id      UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  signing_order     INTEGER,
  all_parties       JSONB,
  request_status    TEXT        NOT NULL DEFAULT 'pending',
  sent_at           TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT signature_requests_status_check CHECK (request_status IN ('pending','sent','partially_signed','completed','cancelled','expired'))
);
CREATE INDEX IF NOT EXISTS idx_signature_requests_doc ON public.signature_requests (document_id, created_at DESC) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signature_requests_status ON public.signature_requests (request_status) WHERE request_status IN ('pending','sent','partially_signed');
ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY signature_requests_select ON public.signature_requests FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY signature_requests_insert ON public.signature_requests FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY signature_requests_update ON public.signature_requests FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY signature_requests_delete ON public.signature_requests FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── dotloop_documents ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dotloop_documents (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  loop_id             TEXT,
  document_id         TEXT,
  document_name       TEXT,
  document_type       TEXT,
  status              TEXT,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dotloop_documents_brokerage ON public.dotloop_documents (brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dotloop_documents_loop ON public.dotloop_documents (loop_id) WHERE loop_id IS NOT NULL;
ALTER TABLE public.dotloop_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY dotloop_documents_select ON public.dotloop_documents FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY dotloop_documents_insert ON public.dotloop_documents FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_lead_visible_role());
CREATE POLICY dotloop_documents_update ON public.dotloop_documents FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY dotloop_documents_delete ON public.dotloop_documents FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── achievements (platform-wide catalog) + agent_achievements (per-agent) ───
CREATE TABLE IF NOT EXISTS public.achievements (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL UNIQUE,
  description     TEXT,
  points_required INTEGER     NOT NULL DEFAULT 0,
  badge_url       TEXT,
  category        TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY achievements_select ON public.achievements FOR SELECT USING (TRUE);
CREATE POLICY achievements_insert ON public.achievements FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY achievements_update ON public.achievements FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY achievements_delete ON public.achievements FOR DELETE USING (public.is_platform_admin());

CREATE TABLE IF NOT EXISTS public.agent_achievements (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  achievement_id  UUID        NOT NULL REFERENCES public.achievements(id) ON DELETE CASCADE,
  unlocked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_achievements_unique UNIQUE (agent_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_achievements_agent ON public.agent_achievements (agent_id, unlocked_at DESC);
CREATE OR REPLACE FUNCTION public.agent_achievements_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_achievements_set_brokerage_trg ON public.agent_achievements;
CREATE TRIGGER agent_achievements_set_brokerage_trg BEFORE INSERT ON public.agent_achievements FOR EACH ROW EXECUTE FUNCTION public.agent_achievements_set_brokerage();
ALTER TABLE public.agent_achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_achievements_select ON public.agent_achievements FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY agent_achievements_insert ON public.agent_achievements FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_ai_isa_system() OR public.is_lead_visible_role());
CREATE POLICY agent_achievements_update ON public.agent_achievements FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY agent_achievements_delete ON public.agent_achievements FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── agent_chat_preferences ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_chat_preferences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID        NOT NULL UNIQUE REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  preferred_model TEXT,
  tone          TEXT,
  preferences   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION public.agent_chat_preferences_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_chat_preferences_set_brokerage_trg ON public.agent_chat_preferences;
CREATE TRIGGER agent_chat_preferences_set_brokerage_trg BEFORE INSERT ON public.agent_chat_preferences FOR EACH ROW EXECUTE FUNCTION public.agent_chat_preferences_set_brokerage();
ALTER TABLE public.agent_chat_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_chat_preferences_select ON public.agent_chat_preferences FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY agent_chat_preferences_insert ON public.agent_chat_preferences FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY agent_chat_preferences_update ON public.agent_chat_preferences FOR UPDATE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())) WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY agent_chat_preferences_delete ON public.agent_chat_preferences FOR DELETE USING (public.is_platform_admin());

-- ─── agent_metrics ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_metrics (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  metric_type   TEXT        NOT NULL,
  metric_value  NUMERIC(20,4),
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_type ON public.agent_metrics (agent_id, metric_type, recorded_at DESC);
CREATE OR REPLACE FUNCTION public.agent_metrics_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_metrics_set_brokerage_trg ON public.agent_metrics;
CREATE TRIGGER agent_metrics_set_brokerage_trg BEFORE INSERT ON public.agent_metrics FOR EACH ROW EXECUTE FUNCTION public.agent_metrics_set_brokerage();
ALTER TABLE public.agent_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_metrics_select ON public.agent_metrics FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY agent_metrics_insert ON public.agent_metrics FOR INSERT WITH CHECK (TRUE);
CREATE POLICY agent_metrics_update ON public.agent_metrics FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY agent_metrics_delete ON public.agent_metrics FOR DELETE USING (public.is_platform_admin());

-- ─── agent_notifications ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_notifications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  type          TEXT,
  title         TEXT,
  body          TEXT,
  data          JSONB,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_notifications_unread ON public.agent_notifications (agent_id, created_at DESC) WHERE read_at IS NULL;
CREATE OR REPLACE FUNCTION public.agent_notifications_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_notifications_set_brokerage_trg ON public.agent_notifications;
CREATE TRIGGER agent_notifications_set_brokerage_trg BEFORE INSERT ON public.agent_notifications FOR EACH ROW EXECUTE FUNCTION public.agent_notifications_set_brokerage();
ALTER TABLE public.agent_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_notifications_select ON public.agent_notifications FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY agent_notifications_insert ON public.agent_notifications FOR INSERT WITH CHECK (TRUE);
CREATE POLICY agent_notifications_update ON public.agent_notifications FOR UPDATE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())) WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY agent_notifications_delete ON public.agent_notifications FOR DELETE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));

-- ─── agent_points_log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_points_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  points          INTEGER     NOT NULL,
  reason          TEXT,
  reference_type  TEXT,
  reference_id    UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_points_log_agent ON public.agent_points_log (agent_id, created_at DESC);
CREATE OR REPLACE FUNCTION public.agent_points_log_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_points_log_set_brokerage_trg ON public.agent_points_log;
CREATE TRIGGER agent_points_log_set_brokerage_trg BEFORE INSERT ON public.agent_points_log FOR EACH ROW EXECUTE FUNCTION public.agent_points_log_set_brokerage();
ALTER TABLE public.agent_points_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_points_log_select ON public.agent_points_log FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY agent_points_log_insert ON public.agent_points_log FOR INSERT WITH CHECK (TRUE);
CREATE POLICY agent_points_log_update ON public.agent_points_log FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY agent_points_log_delete ON public.agent_points_log FOR DELETE USING (public.is_platform_admin());

-- ─── ai_agent_templates ──────────────────────────────────────────────────────
-- Platform-wide library of agent-configuration templates (model, system
-- prompt, tool grants, etc.). Brokerage-private templates also supported.
CREATE TABLE IF NOT EXISTS public.ai_agent_templates (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  template_name   TEXT        NOT NULL,
  description     TEXT,
  template_config JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_global       BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_agent_templates_brokerage ON public.ai_agent_templates (brokerage_id) WHERE brokerage_id IS NOT NULL;
ALTER TABLE public.ai_agent_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_agent_templates_select ON public.ai_agent_templates FOR SELECT USING (is_global OR public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ai_agent_templates_insert ON public.ai_agent_templates FOR INSERT WITH CHECK (public.is_platform_admin() OR (NOT is_global AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY ai_agent_templates_update ON public.ai_agent_templates FOR UPDATE USING (public.is_platform_admin() OR (NOT is_global AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (NOT is_global AND brokerage_id = public.current_user_brokerage_id()));
CREATE POLICY ai_agent_templates_delete ON public.ai_agent_templates FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── calendar_blocks ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.calendar_blocks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  block_type    TEXT,
  reason        TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calendar_blocks_time_check CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_calendar_blocks_agent_window ON public.calendar_blocks (agent_id, starts_at, ends_at);
CREATE OR REPLACE FUNCTION public.calendar_blocks_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS calendar_blocks_set_brokerage_trg ON public.calendar_blocks;
CREATE TRIGGER calendar_blocks_set_brokerage_trg BEFORE INSERT ON public.calendar_blocks FOR EACH ROW EXECUTE FUNCTION public.calendar_blocks_set_brokerage();
ALTER TABLE public.calendar_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY calendar_blocks_select ON public.calendar_blocks FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY calendar_blocks_insert ON public.calendar_blocks FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_lead_visible_role());
CREATE POLICY calendar_blocks_update ON public.calendar_blocks FOR UPDATE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.is_brokerage_admin());
CREATE POLICY calendar_blocks_delete ON public.calendar_blocks FOR DELETE USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
