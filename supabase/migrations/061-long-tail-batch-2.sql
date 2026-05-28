-- =====================================================
-- MIGRATION 061: long-tail batch #2 — 19 missing tables
-- =====================================================
-- Verified by diffing all .from("...") refs in the codebase against the
-- live information_schema. Each table has ≥1 confirmed callsite and a
-- column shape captured directly from the caller's .insert / .select.
-- =====================================================

-- ─── tool_shares ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tool_shares (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  calculation_id      UUID        REFERENCES public.saved_calculations(id) ON DELETE CASCADE,
  share_token         TEXT        NOT NULL UNIQUE,
  shared_with_email   TEXT,
  view_count          INTEGER     NOT NULL DEFAULT 0,
  last_viewed_at      TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_shares_calculation ON public.tool_shares (calculation_id) WHERE calculation_id IS NOT NULL;
ALTER TABLE public.tool_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_shares_select ON public.tool_shares FOR SELECT USING (TRUE);
CREATE POLICY tool_shares_insert ON public.tool_shares FOR INSERT WITH CHECK (TRUE);
CREATE POLICY tool_shares_update ON public.tool_shares FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY tool_shares_delete ON public.tool_shares FOR DELETE USING (public.is_platform_admin());

-- ─── listing_syndication_tracking ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.listing_syndication_tracking (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      UUID        NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  platform_name       TEXT        NOT NULL,
  platform_category   TEXT,
  syndication_status  TEXT        NOT NULL DEFAULT 'pending',
  listing_url         TEXT,
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT listing_syndication_tracking_unique UNIQUE (transaction_id, platform_name),
  CONSTRAINT listing_syndication_tracking_status_check CHECK (syndication_status IN ('pending','active','failed','removed'))
);
CREATE INDEX IF NOT EXISTS idx_lst_brokerage ON public.listing_syndication_tracking (brokerage_id, syndication_status) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.listing_syndication_tracking_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.transaction_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS listing_syndication_tracking_set_brokerage_trg ON public.listing_syndication_tracking;
CREATE TRIGGER listing_syndication_tracking_set_brokerage_trg BEFORE INSERT ON public.listing_syndication_tracking FOR EACH ROW EXECUTE FUNCTION public.listing_syndication_tracking_set_brokerage();
ALTER TABLE public.listing_syndication_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY lst_select ON public.listing_syndication_tracking FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY lst_insert ON public.listing_syndication_tracking FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lst_update ON public.listing_syndication_tracking FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY lst_delete ON public.listing_syndication_tracking FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── ai_tool_favorites ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_tool_favorites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_tool_favorites_unique UNIQUE (user_id, tool_name)
);
ALTER TABLE public.ai_tool_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_tool_favorites_select ON public.ai_tool_favorites FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY ai_tool_favorites_insert ON public.ai_tool_favorites FOR INSERT WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY ai_tool_favorites_update ON public.ai_tool_favorites FOR UPDATE USING (public.is_platform_admin() OR user_id = auth.uid()) WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY ai_tool_favorites_delete ON public.ai_tool_favorites FOR DELETE USING (public.is_platform_admin() OR user_id = auth.uid());

-- ─── listing_marketing_packages ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.listing_marketing_packages (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id        UUID        NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  brokerage_id          UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  package_name          TEXT,
  package_type          TEXT,
  included_services     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  total_estimated_cost  NUMERIC(12,2),
  status                TEXT        NOT NULL DEFAULT 'active',
  activated_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT listing_marketing_packages_type_check CHECK (package_type IS NULL OR package_type IN ('basic','standard','premium','luxury'))
);
CREATE INDEX IF NOT EXISTS idx_lmp_tx ON public.listing_marketing_packages (transaction_id);
CREATE INDEX IF NOT EXISTS idx_lmp_brokerage ON public.listing_marketing_packages (brokerage_id, status) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.listing_marketing_packages_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.transaction_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS listing_marketing_packages_set_brokerage_trg ON public.listing_marketing_packages;
CREATE TRIGGER listing_marketing_packages_set_brokerage_trg BEFORE INSERT ON public.listing_marketing_packages FOR EACH ROW EXECUTE FUNCTION public.listing_marketing_packages_set_brokerage();
ALTER TABLE public.listing_marketing_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY lmp_select ON public.listing_marketing_packages FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY lmp_insert ON public.listing_marketing_packages FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lmp_update ON public.listing_marketing_packages FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY lmp_delete ON public.listing_marketing_packages FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── listing_marketing_services ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.listing_marketing_services (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID        REFERENCES public.listing_marketing_packages(id) ON DELETE CASCADE,
  transaction_id  UUID        REFERENCES public.transactions(id) ON DELETE CASCADE,
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  service_type    TEXT        NOT NULL,
  vendor_id       UUID        REFERENCES public.vendors(id) ON DELETE SET NULL,
  scheduled_date  TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'scheduled',
  estimated_cost  NUMERIC(12,2),
  actual_cost     NUMERIC(12,2),
  completed_at    TIMESTAMPTZ,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lms_package ON public.listing_marketing_services (package_id) WHERE package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lms_brokerage_status ON public.listing_marketing_services (brokerage_id, status) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.listing_marketing_services_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.transaction_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.transaction_id;
    ELSIF NEW.package_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.listing_marketing_packages WHERE id = NEW.package_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS listing_marketing_services_set_brokerage_trg ON public.listing_marketing_services;
CREATE TRIGGER listing_marketing_services_set_brokerage_trg BEFORE INSERT ON public.listing_marketing_services FOR EACH ROW EXECUTE FUNCTION public.listing_marketing_services_set_brokerage();
ALTER TABLE public.listing_marketing_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY lms_select ON public.listing_marketing_services FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY lms_insert ON public.listing_marketing_services FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lms_update ON public.listing_marketing_services FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY lms_delete ON public.listing_marketing_services FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── lead_scraping_jobs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_scraping_jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  market_id       UUID        REFERENCES public.lead_scraping_markets(id) ON DELETE SET NULL,
  job_type        TEXT        NOT NULL,
  source          TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending',
  leads_found     INTEGER     NOT NULL DEFAULT 0,
  leads_created   INTEGER     NOT NULL DEFAULT 0,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_scraping_jobs_status_check CHECK (status IN ('pending','running','completed','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_lsj_market ON public.lead_scraping_jobs (market_id, created_at DESC) WHERE market_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lsj_brokerage ON public.lead_scraping_jobs (brokerage_id, status) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.lead_scraping_jobs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL AND NEW.market_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.lead_scraping_markets WHERE id = NEW.market_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lead_scraping_jobs_set_brokerage_trg ON public.lead_scraping_jobs;
CREATE TRIGGER lead_scraping_jobs_set_brokerage_trg BEFORE INSERT ON public.lead_scraping_jobs FOR EACH ROW EXECUTE FUNCTION public.lead_scraping_jobs_set_brokerage();
ALTER TABLE public.lead_scraping_jobs ENABLE ROW LEVEL SECURITY;
-- Platform-owned (raw scraping); brokerage users do NOT see job details
CREATE POLICY lsj_select ON public.lead_scraping_jobs FOR SELECT USING (public.is_platform_admin());
CREATE POLICY lsj_insert ON public.lead_scraping_jobs FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lsj_update ON public.lead_scraping_jobs FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY lsj_delete ON public.lead_scraping_jobs FOR DELETE USING (public.is_platform_admin());

-- ─── conversation_intelligence ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversation_intelligence (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  lead_id                     UUID        REFERENCES public.leads(id) ON DELETE CASCADE,
  agent_id                    UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  conversation_type           TEXT,
  conversation_id             UUID,
  transcript                  TEXT,
  summary                     TEXT,
  key_points                  TEXT[]      NOT NULL DEFAULT '{}',
  sentiment_score             NUMERIC(5,4),
  intent_detected             TEXT[]      NOT NULL DEFAULT '{}',
  objections_raised           TEXT[]      NOT NULL DEFAULT '{}',
  buying_signals              TEXT[]      NOT NULL DEFAULT '{}',
  pain_points                 TEXT[]      NOT NULL DEFAULT '{}',
  them_first_score            INTEGER,
  coaching_suggestions        TEXT[]      NOT NULL DEFAULT '{}',
  missed_opportunities        TEXT[]      NOT NULL DEFAULT '{}',
  ai_recommended_followup     TEXT,
  optimal_followup_time       TEXT,
  analyzed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ci_lead ON public.conversation_intelligence (lead_id, analyzed_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_agent ON public.conversation_intelligence (agent_id, analyzed_at DESC) WHERE agent_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.conversation_intelligence_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.lead_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id;
    ELSIF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS conversation_intelligence_set_brokerage_trg ON public.conversation_intelligence;
CREATE TRIGGER conversation_intelligence_set_brokerage_trg BEFORE INSERT ON public.conversation_intelligence FOR EACH ROW EXECUTE FUNCTION public.conversation_intelligence_set_brokerage();
ALTER TABLE public.conversation_intelligence ENABLE ROW LEVEL SECURITY;
CREATE POLICY ci_select ON public.conversation_intelligence FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY ci_insert ON public.conversation_intelligence FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ci_update ON public.conversation_intelligence FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY ci_delete ON public.conversation_intelligence FOR DELETE USING (public.is_platform_admin());

-- ─── compliance_alerts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.compliance_alerts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  transaction_id  UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  alert_type      TEXT        NOT NULL,
  severity        TEXT,
  message         TEXT,
  details         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  resolved        BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT compliance_alerts_severity_check CHECK (severity IS NULL OR severity IN ('low','medium','high','critical'))
);
CREATE INDEX IF NOT EXISTS idx_ca_tx ON public.compliance_alerts (transaction_id, resolved) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ca_brokerage ON public.compliance_alerts (brokerage_id, resolved) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.compliance_alerts_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL AND NEW.transaction_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.transaction_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compliance_alerts_set_brokerage_trg ON public.compliance_alerts;
CREATE TRIGGER compliance_alerts_set_brokerage_trg BEFORE INSERT ON public.compliance_alerts FOR EACH ROW EXECUTE FUNCTION public.compliance_alerts_set_brokerage();
ALTER TABLE public.compliance_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY ca_select ON public.compliance_alerts FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ca_insert ON public.compliance_alerts FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ca_update ON public.compliance_alerts FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY ca_delete ON public.compliance_alerts FOR DELETE USING (public.is_platform_admin());

-- ─── closing_gifts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.closing_gifts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  listing_id         UUID        REFERENCES public.listings(id) ON DELETE CASCADE,
  contact_id         UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  agent_id           UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  gift_description   TEXT,
  price_cents        INTEGER,
  order_date         TIMESTAMPTZ,
  delivery_date      TIMESTAMPTZ,
  status             TEXT        NOT NULL DEFAULT 'scheduled',
  ordered_at         TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT closing_gifts_status_check CHECK (status IN ('scheduled','ordered','shipped','delivered','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_cg_listing ON public.closing_gifts (listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cg_brokerage ON public.closing_gifts (brokerage_id, status) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.closing_gifts_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.listing_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.listings WHERE id = NEW.listing_id;
    ELSIF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS closing_gifts_set_brokerage_trg ON public.closing_gifts;
CREATE TRIGGER closing_gifts_set_brokerage_trg BEFORE INSERT ON public.closing_gifts FOR EACH ROW EXECUTE FUNCTION public.closing_gifts_set_brokerage();
ALTER TABLE public.closing_gifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY cg_select ON public.closing_gifts FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY cg_insert ON public.closing_gifts FOR INSERT WITH CHECK (TRUE);
CREATE POLICY cg_update ON public.closing_gifts FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY cg_delete ON public.closing_gifts FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── ai_autopilot_plans ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_autopilot_plans (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  lead_id            UUID        REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id         UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id           UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  autopilot_level    TEXT,
  nurture_plan       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  started_at         TIMESTAMPTZ,
  paused_at          TIMESTAMPTZ,
  next_action_at     TIMESTAMPTZ,
  total_touchpoints  INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aap_agent_active ON public.ai_autopilot_plans (agent_id, is_active, next_action_at) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_aap_brokerage ON public.ai_autopilot_plans (brokerage_id, is_active) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.ai_autopilot_plans_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.lead_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.lead_id;
    ELSIF NEW.contact_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    ELSIF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_autopilot_plans_set_brokerage_trg ON public.ai_autopilot_plans;
CREATE TRIGGER ai_autopilot_plans_set_brokerage_trg BEFORE INSERT ON public.ai_autopilot_plans FOR EACH ROW EXECUTE FUNCTION public.ai_autopilot_plans_set_brokerage();
ALTER TABLE public.ai_autopilot_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY aap_select ON public.ai_autopilot_plans FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY aap_insert ON public.ai_autopilot_plans FOR INSERT WITH CHECK (TRUE);
CREATE POLICY aap_update ON public.ai_autopilot_plans FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())) WITH CHECK (TRUE);
CREATE POLICY aap_delete ON public.ai_autopilot_plans FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── ai_autopilot_actions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_autopilot_actions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id        UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  entity_type     TEXT        NOT NULL,
  entity_id       UUID        NOT NULL,
  action_type     TEXT        NOT NULL,
  title           TEXT,
  description     TEXT,
  priority        TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending',
  scheduled_for   TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_autopilot_actions_status_check CHECK (status IN ('pending','executed','skipped','cancelled')),
  CONSTRAINT ai_autopilot_actions_priority_check CHECK (priority IS NULL OR priority IN ('low','medium','high','critical'))
);
CREATE INDEX IF NOT EXISTS idx_aaa_agent_scheduled ON public.ai_autopilot_actions (agent_id, scheduled_for) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aaa_entity ON public.ai_autopilot_actions (entity_type, entity_id);
CREATE OR REPLACE FUNCTION public.ai_autopilot_actions_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL AND NEW.agent_id IS NOT NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_autopilot_actions_set_brokerage_trg ON public.ai_autopilot_actions;
CREATE TRIGGER ai_autopilot_actions_set_brokerage_trg BEFORE INSERT ON public.ai_autopilot_actions FOR EACH ROW EXECUTE FUNCTION public.ai_autopilot_actions_set_brokerage();
ALTER TABLE public.ai_autopilot_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY aaa_select ON public.ai_autopilot_actions FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY aaa_insert ON public.ai_autopilot_actions FOR INSERT WITH CHECK (TRUE);
CREATE POLICY aaa_update ON public.ai_autopilot_actions FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id())) WITH CHECK (TRUE);
CREATE POLICY aaa_delete ON public.ai_autopilot_actions FOR DELETE USING (public.is_platform_admin());

-- ─── brokerage_settings ──────────────────────────────────────────────────────
-- Per-brokerage configuration / provider credentials. UNIQUE on brokerage_id.
-- Some columns are secrets — RLS limits read to brokerage admins and platform admins.
CREATE TABLE IF NOT EXISTS public.brokerage_settings (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                  UUID        NOT NULL UNIQUE REFERENCES public.brokerages(id) ON DELETE CASCADE,
  ghl_api_key                   TEXT,
  google_calendar_token         TEXT,
  esign_api_key                 TEXT,
  esign_provider                TEXT,
  dotloop_access_token          TEXT,
  heygen_api_key                TEXT,
  idx_api_key                   TEXT,
  social_accounts               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  review_request_delay_days     INTEGER,
  settings                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.brokerage_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY brokerage_settings_select ON public.brokerage_settings FOR SELECT USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY brokerage_settings_insert ON public.brokerage_settings FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY brokerage_settings_update ON public.brokerage_settings FOR UPDATE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY brokerage_settings_delete ON public.brokerage_settings FOR DELETE USING (public.is_platform_admin());

-- ─── ai_isa_settings ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_isa_settings (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id              UUID        NOT NULL UNIQUE REFERENCES public.brokerages(id) ON DELETE CASCADE,
  vapi_assistant_id         TEXT,
  vapi_phone_number_id      TEXT,
  elevenlabs_voice_id       TEXT,
  is_active                 BOOLEAN     NOT NULL DEFAULT FALSE,
  require_broker_approval   BOOLEAN     NOT NULL DEFAULT TRUE,
  settings                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.ai_isa_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_isa_settings_select ON public.ai_isa_settings FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR public.is_ai_isa_system());
CREATE POLICY ai_isa_settings_insert ON public.ai_isa_settings FOR INSERT WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY ai_isa_settings_update ON public.ai_isa_settings FOR UPDATE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));
CREATE POLICY ai_isa_settings_delete ON public.ai_isa_settings FOR DELETE USING (public.is_platform_admin());

-- ─── calculator_history ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.calculator_history (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  lead_id           UUID        REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id        UUID        REFERENCES public.contacts(id) ON DELETE CASCADE,
  calculator_type   TEXT        NOT NULL,
  inputs            JSONB,
  results           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ch_lead ON public.calculator_history (lead_id, created_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_contact ON public.calculator_history (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.calculator_history_set_brokerage() RETURNS TRIGGER AS $$
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
DROP TRIGGER IF EXISTS calculator_history_set_brokerage_trg ON public.calculator_history;
CREATE TRIGGER calculator_history_set_brokerage_trg BEFORE INSERT ON public.calculator_history FOR EACH ROW EXECUTE FUNCTION public.calculator_history_set_brokerage();
ALTER TABLE public.calculator_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY ch_select ON public.calculator_history FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY ch_insert ON public.calculator_history FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ch_update ON public.calculator_history FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY ch_delete ON public.calculator_history FOR DELETE USING (public.is_platform_admin());

-- ─── commission_records ──────────────────────────────────────────────────────
-- Distinct from commission_splits (allocation) — this is the per-deal GCI ledger
-- the brokerage P&L rollup reads from.
CREATE TABLE IF NOT EXISTS public.commission_records (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id            UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  transaction_id      UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  gross_commission    NUMERIC(14,2) NOT NULL DEFAULT 0,
  agent_net           NUMERIC(14,2) NOT NULL DEFAULT 0,
  brokerage_net       NUMERIC(14,2),
  paid_date           DATE,
  status              TEXT        NOT NULL DEFAULT 'pending',
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT commission_records_status_check CHECK (status IN ('pending','approved','paid','disputed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_cr_agent_paid ON public.commission_records (agent_id, paid_date DESC) WHERE paid_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cr_brokerage ON public.commission_records (brokerage_id, paid_date DESC) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.commission_records_set_brokerage() RETURNS TRIGGER AS $$
BEGIN IF NEW.brokerage_id IS NULL THEN SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS commission_records_set_brokerage_trg ON public.commission_records;
CREATE TRIGGER commission_records_set_brokerage_trg BEFORE INSERT ON public.commission_records FOR EACH ROW EXECUTE FUNCTION public.commission_records_set_brokerage();
ALTER TABLE public.commission_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY cr_select ON public.commission_records FOR SELECT USING (public.is_platform_admin() OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()) OR public.has_brokerage_access(brokerage_id));
CREATE POLICY cr_insert ON public.commission_records FOR INSERT WITH CHECK (public.is_platform_admin() OR public.is_brokerage_admin());
CREATE POLICY cr_update ON public.commission_records FOR UPDATE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))) WITH CHECK (TRUE);
CREATE POLICY cr_delete ON public.commission_records FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ─── document_folders ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_folders (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id            UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  folder_name             TEXT        NOT NULL,
  folder_type             TEXT,
  parent_folder_id        UUID        REFERENCES public.document_folders(id) ON DELETE CASCADE,
  related_transaction_id  UUID        REFERENCES public.transactions(id) ON DELETE SET NULL,
  related_lead_id         UUID        REFERENCES public.leads(id) ON DELETE SET NULL,
  related_contact_id      UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_folders_type_check CHECK (folder_type IS NULL OR folder_type IN ('transaction','client','template','marketing','compliance'))
);
CREATE INDEX IF NOT EXISTS idx_df_parent ON public.document_folders (parent_folder_id) WHERE parent_folder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_df_brokerage ON public.document_folders (brokerage_id) WHERE brokerage_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.document_folders_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.related_transaction_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.transactions WHERE id = NEW.related_transaction_id;
    ELSIF NEW.related_lead_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.leads WHERE id = NEW.related_lead_id;
    ELSIF NEW.related_contact_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.related_contact_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS document_folders_set_brokerage_trg ON public.document_folders;
CREATE TRIGGER document_folders_set_brokerage_trg BEFORE INSERT ON public.document_folders FOR EACH ROW EXECUTE FUNCTION public.document_folders_set_brokerage();
ALTER TABLE public.document_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY df_select ON public.document_folders FOR SELECT USING (public.is_platform_admin() OR (brokerage_id IS NULL) OR public.has_brokerage_access(brokerage_id) OR created_by = auth.uid());
CREATE POLICY df_insert ON public.document_folders FOR INSERT WITH CHECK (TRUE);
CREATE POLICY df_update ON public.document_folders FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR created_by = auth.uid()) WITH CHECK (TRUE);
CREATE POLICY df_delete ON public.document_folders FOR DELETE USING (public.is_platform_admin() OR created_by = auth.uid());

-- ─── document_templates ──────────────────────────────────────────────────────
-- Platform-published template library (state-specific real-estate forms).
CREATE TABLE IF NOT EXISTS public.document_templates (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name               TEXT        NOT NULL,
  template_type               TEXT,
  template_category           TEXT,
  template_content            TEXT,
  template_file_url           TEXT,
  state_specific              TEXT[]      NOT NULL DEFAULT '{}',
  is_active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  is_compliance_approved      BOOLEAN     NOT NULL DEFAULT FALSE,
  requires_client_signature   BOOLEAN     NOT NULL DEFAULT FALSE,
  metadata                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dt_active_category ON public.document_templates (template_category, is_active) WHERE is_active = TRUE;
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY dt_select ON public.document_templates FOR SELECT USING (TRUE);
CREATE POLICY dt_insert ON public.document_templates FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY dt_update ON public.document_templates FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY dt_delete ON public.document_templates FOR DELETE USING (public.is_platform_admin());

-- ─── assistant_queries ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assistant_queries (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,
  query       TEXT,
  context     JSONB,
  timestamp   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aq_user ON public.assistant_queries (user_id, created_at DESC) WHERE user_id IS NOT NULL;
ALTER TABLE public.assistant_queries ENABLE ROW LEVEL SECURITY;
CREATE POLICY aq_select ON public.assistant_queries FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY aq_insert ON public.assistant_queries FOR INSERT WITH CHECK (TRUE);
CREATE POLICY aq_update ON public.assistant_queries FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY aq_delete ON public.assistant_queries FOR DELETE USING (public.is_platform_admin());

-- ─── fair_housing_logs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fair_housing_logs (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                  UUID        REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id                    UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  agent_id                      UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  interaction_type              TEXT,
  communication_text            TEXT,
  protected_class_mentioned     BOOLEAN     NOT NULL DEFAULT FALSE,
  steering_risk_detected        BOOLEAN     NOT NULL DEFAULT FALSE,
  ai_analysis                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  risk_score                    NUMERIC(5,4),
  flagged_phrases               TEXT[]      NOT NULL DEFAULT '{}',
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fhl_brokerage ON public.fair_housing_logs (brokerage_id, created_at DESC) WHERE brokerage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fhl_contact ON public.fair_housing_logs (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.fair_housing_logs_set_brokerage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.contact_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.contacts WHERE id = NEW.contact_id;
    ELSIF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fair_housing_logs_set_brokerage_trg ON public.fair_housing_logs;
CREATE TRIGGER fair_housing_logs_set_brokerage_trg BEFORE INSERT ON public.fair_housing_logs FOR EACH ROW EXECUTE FUNCTION public.fair_housing_logs_set_brokerage();
ALTER TABLE public.fair_housing_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY fhl_select ON public.fair_housing_logs FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id));
CREATE POLICY fhl_insert ON public.fair_housing_logs FOR INSERT WITH CHECK (TRUE);
CREATE POLICY fhl_update ON public.fair_housing_logs FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY fhl_delete ON public.fair_housing_logs FOR DELETE USING (public.is_platform_admin());
