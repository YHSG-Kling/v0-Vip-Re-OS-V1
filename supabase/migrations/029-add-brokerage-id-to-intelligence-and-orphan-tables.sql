-- Migration 029: Add brokerage_id to 14 tables that were orphans from the
-- multi-tenant model
--
-- Business context: subscriptions are billed at four levels (solo_agent,
-- team, brokerage, multi_location). Every paid operation — AI inference,
-- third-party scraping (ZenRows, Apify, BatchData, OSINT, Google Search),
-- compliance reviews, behavioral enrichment — needs to be attributable to
-- a specific brokerage so the superadmin's billing + cost rollups +
-- fair-use enforcement can work correctly. As the platform's growth path
-- is agent → team → brokerage → multi_location, even tables created
-- during the solo-agent stage must carry brokerage_id so the rollup view
-- is consistent when the brokerage signs up later.
--
-- All target tables were empty or near-empty at apply time, so the column
-- is added as NULLABLE (no default backfill needed) with an ON DELETE
-- SET NULL FK to brokerages. Auth-only RLS policies installed by
-- migration 028 are replaced with brokerage-scoped policies that use
-- current_user_brokerage_id() — matching the pattern used elsewhere in
-- the schema. Service role continues to bypass RLS for cron / background
-- work.
--
-- Applied: 2026-05-18

-- ── 1. Add brokerage_id column + FK + index ──────────────────────────

ALTER TABLE public.batchdata_motivated_sellers_raw
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_batchdata_motivated_sellers_brokerage ON public.batchdata_motivated_sellers_raw(brokerage_id);

ALTER TABLE public.behavioral_signals
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_behavioral_signals_brokerage ON public.behavioral_signals(brokerage_id);

ALTER TABLE public.property_intelligence
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_property_intelligence_brokerage ON public.property_intelligence(brokerage_id);

ALTER TABLE public.external_behavior
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_external_behavior_brokerage ON public.external_behavior(brokerage_id);

ALTER TABLE public.google_search_intelligence
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_google_search_intelligence_brokerage ON public.google_search_intelligence(brokerage_id);

ALTER TABLE public.motivated_seller_signals
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_motivated_seller_signals_brokerage ON public.motivated_seller_signals(brokerage_id);

ALTER TABLE public.intelligent_outreach_log
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_intelligent_outreach_log_brokerage ON public.intelligent_outreach_log(brokerage_id);

ALTER TABLE public.site_activity
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_site_activity_brokerage ON public.site_activity(brokerage_id);

ALTER TABLE public.intelligence_signals_log
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_intelligence_signals_log_brokerage ON public.intelligence_signals_log(brokerage_id);

ALTER TABLE public.agent_assistant_tool_calls
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_agent_assistant_tool_calls_brokerage ON public.agent_assistant_tool_calls(brokerage_id);

ALTER TABLE public.compliance_checks
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_checks_brokerage ON public.compliance_checks(brokerage_id);

ALTER TABLE public.objection_scenario_agents
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_objection_scenario_agents_brokerage ON public.objection_scenario_agents(brokerage_id);

ALTER TABLE public.social_search_raw_results
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_social_search_raw_results_brokerage ON public.social_search_raw_results(brokerage_id);

ALTER TABLE public.zenrows_property_search_raw
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_zenrows_property_search_raw_brokerage ON public.zenrows_property_search_raw(brokerage_id);

-- ── 2. Replace auth_only RLS policies (from migration 028) with
--    brokerage-scoped ones on the 6 tables previously gated by auth-only ──

DROP POLICY IF EXISTS "agent_assistant_tool_calls_auth_only" ON public.agent_assistant_tool_calls;
CREATE POLICY "agent_assistant_tool_calls_tenant"
  ON public.agent_assistant_tool_calls FOR ALL
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS "batchdata_motivated_sellers_auth_only" ON public.batchdata_motivated_sellers_raw;
CREATE POLICY "batchdata_motivated_sellers_tenant"
  ON public.batchdata_motivated_sellers_raw FOR ALL
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS "compliance_checks_auth_only" ON public.compliance_checks;
CREATE POLICY "compliance_checks_tenant"
  ON public.compliance_checks FOR ALL
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS "objection_scenario_agents_auth_only" ON public.objection_scenario_agents;
CREATE POLICY "objection_scenario_agents_tenant"
  ON public.objection_scenario_agents FOR ALL
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS "social_search_raw_auth_only" ON public.social_search_raw_results;
CREATE POLICY "social_search_raw_tenant"
  ON public.social_search_raw_results FOR ALL
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS "zenrows_property_search_auth_only" ON public.zenrows_property_search_raw;
CREATE POLICY "zenrows_property_search_tenant"
  ON public.zenrows_property_search_raw FOR ALL
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

-- ── 3. Enable RLS + install brokerage-scoped policies on the 8
--    newly-attributed tables that didn't previously have RLS coverage ────

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'behavioral_signals',
      'property_intelligence',
      'external_behavior',
      'google_search_intelligence',
      'motivated_seller_signals',
      'intelligent_outreach_log',
      'site_activity',
      'intelligence_signals_log'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL ' ||
      'USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()) ' ||
      'WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())',
      t || '_tenant', t
    );
  END LOOP;
END $$;
