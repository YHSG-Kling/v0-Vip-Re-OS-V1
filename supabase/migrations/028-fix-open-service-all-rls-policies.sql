-- Migration 028: Fix 50+ RLS policies incorrectly scoped to {public} role
--
-- PROBLEM: Throughout the schema, policies named "*_svc_all" / "*_service_all" /
-- "Service role manages *" were created with qual='true' and roles='{public}'.
-- The intent was to allow the service-role (admin) client to bypass tenant
-- scoping. However:
--   1. service_role already bypasses RLS entirely — these policies were
--      always redundant for that purpose.
--   2. roles='{public}' means Postgres anon + authenticated roles ALSO get
--      unrestricted access, effectively disabling RLS for those tables.
--
-- FIX:
--   - Drop all qual=true / roles={public} policies that were masquerading as
--     service-role guards.
--   - For tables that already have other scoped policies: just drop (the
--     scoped policies continue to work for legitimate callers).
--   - For tables with no other policies: replace with auth.uid() IS NOT NULL
--     so at minimum a login is required.
--   - Intentionally-public read-only tables (plan_limits, platform_settings,
--     state_protected_classes) are left untouched.
--
-- Applied: 2026-05-18

DROP POLICY IF EXISTS "Service role manages agent_assistant_sessions"         ON public.agent_assistant_sessions;
DROP POLICY IF EXISTS "Service role manages agent_avatar_assets"               ON public.agent_avatar_assets;
DROP POLICY IF EXISTS "ai_quota_overrides_svc_all"                             ON public.ai_quota_overrides;
DROP POLICY IF EXISTS "bii_service_all"                                        ON public.brokerage_intelligence_insights;
DROP POLICY IF EXISTS "Service role manages budgets"                           ON public.budgets;
DROP POLICY IF EXISTS "bba_svc_all"                                            ON public.buyer_broker_agreements;
DROP POLICY IF EXISTS "service_role_update_chat_sessions"                      ON public.chat_sessions;
DROP POLICY IF EXISTS "System can update insights"                             ON public.conversation_insights;
DROP POLICY IF EXISTS "dsr_svc_all"                                            ON public.data_subject_requests;
DROP POLICY IF EXISTS "Service role manages embed_sessions"                    ON public.embed_sessions;
DROP POLICY IF EXISTS "Service role manages embed_widgets"                     ON public.embed_widgets;
DROP POLICY IF EXISTS "Service role manages financial_reports"                 ON public.financial_reports;
DROP POLICY IF EXISTS "ifga_svc_all"                                           ON public.income_forecast_gap_analysis;
DROP POLICY IF EXISTS "ifs_service_all"                                        ON public.income_forecast_snapshots;
DROP POLICY IF EXISTS "igra_svc_all"                                           ON public.income_gap_recommended_actions;
DROP POLICY IF EXISTS "service_role_access"                                    ON public.lead_enrichment_queue;
DROP POLICY IF EXISTS "la_service_all"                                         ON public.learning_assignments;
DROP POLICY IF EXISTS "lmcp_service_all"                                       ON public.learning_module_channel_publications;
DROP POLICY IF EXISTS "lm_service_all"                                         ON public.learning_modules;
DROP POLICY IF EXISTS "npv_service_all"                                        ON public.lifetime_customer_npv_scores;
DROP POLICY IF EXISTS "service role manages listing_health_interventions"      ON public.listing_health_interventions;
DROP POLICY IF EXISTS "service role manages listing_health_scores"             ON public.listing_health_scores;
DROP POLICY IF EXISTS "mac_service_all"                                        ON public.marketing_attribution_credits;
DROP POLICY IF EXISTS "mct_service_all"                                        ON public.marketing_campaign_touchpoints;
DROP POLICY IF EXISTS "mctr_service_all"                                       ON public.marketing_campaign_triggers;
DROP POLICY IF EXISTS "ns_service_all"                                         ON public.negotiation_strategies;
DROP POLICY IF EXISTS "Service role manages open_houses"                       ON public.open_houses;
DROP POLICY IF EXISTS "omcl_svc_all"                                           ON public.outbound_message_compliance_log;
DROP POLICY IF EXISTS "pa_service_all"                                         ON public.pattern_adoptions;
DROP POLICY IF EXISTS "pes_service_all"                                        ON public.portal_event_stream;
DROP POLICY IF EXISTS "pa_svc_all"                                             ON public.privacy_acceptances;
DROP POLICY IF EXISTS "System update raw leads"                                ON public.raw_scraped_leads;
DROP POLICY IF EXISTS "rps_service_all"                                        ON public.revenue_protection_snapshots;
DROP POLICY IF EXISTS "service_role_access"                                    ON public.scraper_executions;
DROP POLICY IF EXISTS "sal_svc_all"                                            ON public.superadmin_audit_log;
DROP POLICY IF EXISTS "tenant_safety_findings_service_all"                     ON public.tenant_safety_findings;
DROP POLICY IF EXISTS "Service role manages usage_counters"                    ON public.usage_counters;
DROP POLICY IF EXISTS "Service role manages usage_events"                      ON public.usage_events;
DROP POLICY IF EXISTS "user_invitations_svc_all"                               ON public.user_invitations;
DROP POLICY IF EXISTS "vendor_bookings_svc_all"                                ON public.vendor_bookings;
DROP POLICY IF EXISTS "vca_svc_all"                                            ON public.vendor_contact_assignments;
DROP POLICY IF EXISTS "vendor_invitations_svc_all"                             ON public.vendor_invitations;
DROP POLICY IF EXISTS "Service role manages video_render_log"                  ON public.video_render_log;
DROP POLICY IF EXISTS "vrl_service_all"                                        ON public.video_render_log;
DROP POLICY IF EXISTS "Service role manages compliance_checks"                 ON public.compliance_checks;

-- Tables with no other policies: require login at minimum
DROP POLICY IF EXISTS "Service role manages agent_assistant_tool_calls"       ON public.agent_assistant_tool_calls;
CREATE POLICY "agent_assistant_tool_calls_auth_only"
  ON public.agent_assistant_tool_calls FOR ALL
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "service_role_access"                                   ON public.batchdata_motivated_sellers_raw;
CREATE POLICY "batchdata_motivated_sellers_auth_only"
  ON public.batchdata_motivated_sellers_raw FOR ALL
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "compliance_checks_auth_only"
  ON public.compliance_checks FOR ALL
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Service role manages objection_scenario_agents"        ON public.objection_scenario_agents;
CREATE POLICY "objection_scenario_agents_auth_only"
  ON public.objection_scenario_agents FOR ALL
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "service_role_access"                                   ON public.social_search_raw_results;
CREATE POLICY "social_search_raw_auth_only"
  ON public.social_search_raw_results FOR ALL
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "service_role_access"                                   ON public.zenrows_property_search_raw;
CREATE POLICY "zenrows_property_search_auth_only"
  ON public.zenrows_property_search_raw FOR ALL
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
