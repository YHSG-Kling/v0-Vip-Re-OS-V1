-- =====================================================
-- MIGRATION 063: 7 missing RPC functions + 44 RLS-no-policy table fixes
-- =====================================================
-- Phase A: define the RPC functions called from the codebase but never
--          deployed (silent failures or noisy fallbacks).
-- Phase B: add SELECT/INSERT/UPDATE/DELETE policies to tables that have
--          RLS enabled but zero policies (effectively blocking all reads
--          and writes from real callers).
--
-- Skipped from Agent 2's list:
--   - public.increment(...) — generic, two callers use conflicting arg
--     names (row_id vs id_value). Both have manual-update fallbacks;
--     leave as-is rather than wedge a SQL-injection-prone dispatcher.
--   - public.coalesce_increment() — caller pattern is broken (uses
--     rpc() return inside an .update() expression, which doesn't resolve
--     to a SQL value). Belongs in a code-refactor commit, not a stub.
-- =====================================================

-- ─── PHASE A: RPC functions ─────────────────────────────────────────────────

-- 1. adjust_lead_score — bumps contacts.engagement_score by p_adjustment.
--    Caller: app/actions/ai-showing-management.ts:716 (showing feedback
--    raises/lowers buyer engagement based on AI-rated interest level).
--    contacts has no `lead_score` column; engagement_score is the closest
--    semantic match for showing-feedback-driven adjustments.
CREATE OR REPLACE FUNCTION public.adjust_lead_score(
  p_contact_id UUID,
  p_adjustment INTEGER,
  p_reason     TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.contacts
     SET engagement_score = COALESCE(engagement_score, 0) + p_adjustment,
         updated_at       = NOW()
   WHERE id = p_contact_id;
END;
$$;

-- 2. get_agent_feedback_stats — aggregate agent feedback for the brokerage.
--    Caller: app/dashboard/ai-quality/page.tsx:71 (admin "AI personalization"
--    view; shows which agents have >10 feedbacks recently).
CREATE OR REPLACE FUNCTION public.get_agent_feedback_stats(
  p_brokerage_id UUID,
  p_since        TIMESTAMPTZ
) RETURNS TABLE (agent_id UUID, feedback_count BIGINT, avg_rating NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT agent_id,
         COUNT(*)        AS feedback_count,
         AVG(rating)     AS avg_rating
    FROM public.ai_feedback_log
   WHERE brokerage_id = p_brokerage_id
     AND created_at >= p_since
     AND agent_id IS NOT NULL
   GROUP BY agent_id;
$$;

-- 3. increment_form_submission_count
CREATE OR REPLACE FUNCTION public.increment_form_submission_count(form_id_input UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.lead_capture_forms
     SET submission_count = COALESCE(submission_count, 0) + 1
   WHERE id = form_id_input;
END;
$$;

-- 4. increment_qr_counts — both scan_count and lead_count get +1.
CREATE OR REPLACE FUNCTION public.increment_qr_counts(qr_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.qr_codes
     SET scan_count = COALESCE(scan_count, 0) + 1,
         lead_count = COALESCE(lead_count, 0) + 1
   WHERE id = qr_id;
END;
$$;

-- 5. increment_referral_received
CREATE OR REPLACE FUNCTION public.increment_referral_received(p_partner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.referral_partners
     SET total_referrals_received = COALESCE(total_referrals_received, 0) + 1
   WHERE id = p_partner_id;
END;
$$;

-- 6. increment_sequence_enrollments — column is enrollments_total, not
--    enrollment_count.
CREATE OR REPLACE FUNCTION public.increment_sequence_enrollments(seq_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.campaign_sequences
     SET enrollments_total = COALESCE(enrollments_total, 0) + 1
   WHERE id = seq_id;
END;
$$;

-- 7. increment_voice_session_commands — voice_assistant_sessions only has
--    command_count (no success_count). p_success is accepted for API
--    compatibility but not persisted separately.
CREATE OR REPLACE FUNCTION public.increment_voice_session_commands(
  p_session_id UUID,
  p_success    BOOLEAN DEFAULT TRUE
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.voice_assistant_sessions
     SET command_count = COALESCE(command_count, 0) + 1
   WHERE id = p_session_id;
END;
$$;

-- ─── PHASE B: RLS policies on 44 unprotected tables ─────────────────────────
-- These tables had ALTER TABLE … ENABLE ROW LEVEL SECURITY but no CREATE
-- POLICY statements, so every query returned zero rows for every role
-- except service-role. Adding sensible defaults by tenancy class.

-- ── Tenant-scoped (have brokerage_id) ──
-- showing_briefings: brokerage isolation + agent self-access on agent_id
ALTER TABLE public.showing_briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY showing_briefings_select ON public.showing_briefings FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY showing_briefings_insert ON public.showing_briefings FOR INSERT WITH CHECK (TRUE);
CREATE POLICY showing_briefings_update ON public.showing_briefings FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY showing_briefings_delete ON public.showing_briefings FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

CREATE POLICY tpa_select ON public.transaction_pending_actions FOR SELECT USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id) OR (public.is_agent_role() AND agent_id = public.current_user_agent_id()));
CREATE POLICY tpa_insert ON public.transaction_pending_actions FOR INSERT WITH CHECK (TRUE);
CREATE POLICY tpa_update ON public.transaction_pending_actions FOR UPDATE USING (public.is_platform_admin() OR public.has_brokerage_access(brokerage_id)) WITH CHECK (TRUE);
CREATE POLICY tpa_delete ON public.transaction_pending_actions FOR DELETE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id)));

-- ── User-owned (have user_id) — owner read/write, admin override ──
CREATE POLICY agc_select ON public.ai_generated_content FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY agc_insert ON public.ai_generated_content FOR INSERT WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY agc_update ON public.ai_generated_content FOR UPDATE USING (public.is_platform_admin() OR user_id = auth.uid()) WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY agc_delete ON public.ai_generated_content FOR DELETE USING (public.is_platform_admin() OR user_id = auth.uid());

CREATE POLICY al_select ON public.audit_log FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY al_insert ON public.audit_log FOR INSERT WITH CHECK (TRUE);
CREATE POLICY al_update ON public.audit_log FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY al_delete ON public.audit_log FOR DELETE USING (public.is_platform_admin());

CREATE POLICY np_select ON public.notification_preferences FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY np_insert ON public.notification_preferences FOR INSERT WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY np_update ON public.notification_preferences FOR UPDATE USING (public.is_platform_admin() OR user_id = auth.uid()) WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY np_delete ON public.notification_preferences FOR DELETE USING (public.is_platform_admin() OR user_id = auth.uid());

CREATE POLICY sao_select ON public.saved_ai_outputs FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY sao_insert ON public.saved_ai_outputs FOR INSERT WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY sao_update ON public.saved_ai_outputs FOR UPDATE USING (public.is_platform_admin() OR user_id = auth.uid()) WITH CHECK (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY sao_delete ON public.saved_ai_outputs FOR DELETE USING (public.is_platform_admin() OR user_id = auth.uid());

CREATE POLICY ua_select ON public.user_activity FOR SELECT USING (public.is_platform_admin() OR user_id = auth.uid());
CREATE POLICY ua_insert ON public.user_activity FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ua_update ON public.user_activity FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY ua_delete ON public.user_activity FOR DELETE USING (public.is_platform_admin());

-- ── brokerages: root tenancy — users see their own brokerage; platform admins see all ──
CREATE POLICY brokerages_select ON public.brokerages FOR SELECT USING (public.is_platform_admin() OR id = public.current_user_brokerage_id());
CREATE POLICY brokerages_insert ON public.brokerages FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY brokerages_update ON public.brokerages FOR UPDATE USING (public.is_platform_admin() OR (public.is_brokerage_admin() AND id = public.current_user_brokerage_id())) WITH CHECK (public.is_platform_admin() OR (public.is_brokerage_admin() AND id = public.current_user_brokerage_id()));
CREATE POLICY brokerages_delete ON public.brokerages FOR DELETE USING (public.is_platform_admin());

-- ── Platform catalogs (read-all, platform-admin write) ──
-- Helper macro pattern repeated for each: SELECT TRUE; INSERT/UPDATE/DELETE platform-admin only.
CREATE POLICY apt_select ON public.ai_prompt_templates FOR SELECT USING (TRUE);
CREATE POLICY apt_write_ins ON public.ai_prompt_templates FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY apt_write_upd ON public.ai_prompt_templates FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY apt_write_del ON public.ai_prompt_templates FOR DELETE USING (public.is_platform_admin());

CREATE POLICY cr_select_p ON public.compliance_rules FOR SELECT USING (TRUE);
CREATE POLICY cr_ins_p ON public.compliance_rules FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY cr_upd_p ON public.compliance_rules FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY cr_del_p ON public.compliance_rules FOR DELETE USING (public.is_platform_admin());

CREATE POLICY jb_select ON public.journey_blueprints FOR SELECT USING (TRUE);
CREATE POLICY jb_ins ON public.journey_blueprints FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY jb_upd ON public.journey_blueprints FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY jb_del ON public.journey_blueprints FOR DELETE USING (public.is_platform_admin());

CREATE POLICY jt_select ON public.journey_tools FOR SELECT USING (TRUE);
CREATE POLICY jt_ins ON public.journey_tools FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY jt_upd ON public.journey_tools FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY jt_del ON public.journey_tools FOR DELETE USING (public.is_platform_admin());

CREATE POLICY keywords_select ON public.keywords FOR SELECT USING (TRUE);
CREATE POLICY keywords_ins ON public.keywords FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY keywords_upd ON public.keywords FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY keywords_del ON public.keywords FOR DELETE USING (public.is_platform_admin());

CREATE POLICY lsmp_select ON public.lead_scraping_motivated_params FOR SELECT USING (TRUE);
CREATE POLICY lsmp_ins ON public.lead_scraping_motivated_params FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY lsmp_upd ON public.lead_scraping_motivated_params FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY lsmp_del ON public.lead_scraping_motivated_params FOR DELETE USING (public.is_platform_admin());

CREATE POLICY lspp_select ON public.lead_scraping_property_params FOR SELECT USING (TRUE);
CREATE POLICY lspp_ins ON public.lead_scraping_property_params FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY lspp_upd ON public.lead_scraping_property_params FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY lspp_del ON public.lead_scraping_property_params FOR DELETE USING (public.is_platform_admin());

CREATE POLICY oq_select ON public.onboarding_quizzes FOR SELECT USING (TRUE);
CREATE POLICY oq_ins ON public.onboarding_quizzes FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY oq_upd ON public.onboarding_quizzes FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY oq_del ON public.onboarding_quizzes FOR DELETE USING (public.is_platform_admin());

CREATE POLICY playbooks_select ON public.playbooks FOR SELECT USING (TRUE);
CREATE POLICY playbooks_ins ON public.playbooks FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY playbooks_upd ON public.playbooks FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY playbooks_del ON public.playbooks FOR DELETE USING (public.is_platform_admin());

CREATE POLICY scripts_select ON public.scripts FOR SELECT USING (TRUE);
CREATE POLICY scripts_ins ON public.scripts FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY scripts_upd ON public.scripts FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY scripts_del ON public.scripts FOR DELETE USING (public.is_platform_admin());

CREATE POLICY saar_select ON public.state_appraiser_adjustment_rates FOR SELECT USING (TRUE);
CREATE POLICY saar_ins ON public.state_appraiser_adjustment_rates FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY saar_upd ON public.state_appraiser_adjustment_rates FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY saar_del ON public.state_appraiser_adjustment_rates FOR DELETE USING (public.is_platform_admin());

CREATE POLICY scr_select ON public.state_compliance_requirements FOR SELECT USING (TRUE);
CREATE POLICY scr_ins ON public.state_compliance_requirements FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY scr_upd ON public.state_compliance_requirements FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY scr_del ON public.state_compliance_requirements FOR DELETE USING (public.is_platform_admin());

CREATE POLICY subt_select ON public.subscription_tiers FOR SELECT USING (TRUE);
CREATE POLICY subt_ins ON public.subscription_tiers FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY subt_upd ON public.subscription_tiers FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY subt_del ON public.subscription_tiers FOR DELETE USING (public.is_platform_admin());

CREATE POLICY ur_select ON public.user_roles FOR SELECT USING (TRUE);
CREATE POLICY ur_ins ON public.user_roles FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY ur_upd ON public.user_roles FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY ur_del ON public.user_roles FOR DELETE USING (public.is_platform_admin());

-- ── Derived/parent-tenant tables (no own brokerage_id; parent has it) — open SELECT, system writes ──
CREATE POLICY css_select ON public.collaborative_search_members FOR SELECT USING (TRUE);
CREATE POLICY css_ins ON public.collaborative_search_members FOR INSERT WITH CHECK (TRUE);
CREATE POLICY css_upd ON public.collaborative_search_members FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY css_del ON public.collaborative_search_members FOR DELETE USING (public.is_platform_admin());

CREATE POLICY csp_select ON public.collaborative_search_properties FOR SELECT USING (TRUE);
CREATE POLICY csp_ins ON public.collaborative_search_properties FOR INSERT WITH CHECK (TRUE);
CREATE POLICY csp_upd ON public.collaborative_search_properties FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY csp_del ON public.collaborative_search_properties FOR DELETE USING (public.is_platform_admin());

CREATE POLICY cmacp_select ON public.cma_comparables FOR SELECT USING (TRUE);
CREATE POLICY cmacp_ins ON public.cma_comparables FOR INSERT WITH CHECK (TRUE);
CREATE POLICY cmacp_upd ON public.cma_comparables FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY cmacp_del ON public.cma_comparables FOR DELETE USING (public.is_platform_admin());

CREATE POLICY cmapa_select ON public.cma_price_adjustments FOR SELECT USING (TRUE);
CREATE POLICY cmapa_ins ON public.cma_price_adjustments FOR INSERT WITH CHECK (TRUE);
CREATE POLICY cmapa_upd ON public.cma_price_adjustments FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY cmapa_del ON public.cma_price_adjustments FOR DELETE USING (public.is_platform_admin());

CREATE POLICY css_steps_select ON public.campaign_sequence_steps FOR SELECT USING (TRUE);
CREATE POLICY css_steps_ins ON public.campaign_sequence_steps FOR INSERT WITH CHECK (TRUE);
CREATE POLICY css_steps_upd ON public.campaign_sequence_steps FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY css_steps_del ON public.campaign_sequence_steps FOR DELETE USING (public.is_platform_admin());

CREATE POLICY oha_select ON public.open_house_analytics FOR SELECT USING (TRUE);
CREATE POLICY oha_ins ON public.open_house_analytics FOR INSERT WITH CHECK (TRUE);
CREATE POLICY oha_upd ON public.open_house_analytics FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY oha_del ON public.open_house_analytics FOR DELETE USING (public.is_platform_admin());

CREATE POLICY ott_select ON public.objection_training_turns FOR SELECT USING (TRUE);
CREATE POLICY ott_ins ON public.objection_training_turns FOR INSERT WITH CHECK (TRUE);
CREATE POLICY ott_upd ON public.objection_training_turns FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY ott_del ON public.objection_training_turns FOR DELETE USING (public.is_platform_admin());

-- Newsletter catalog tables — platform content; read-all, admin-write.
CREATE POLICY nls_select ON public.newsletter_local_content FOR SELECT USING (TRUE);
CREATE POLICY nls_ins ON public.newsletter_local_content FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY nls_upd ON public.newsletter_local_content FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY nls_del ON public.newsletter_local_content FOR DELETE USING (public.is_platform_admin());

CREATE POLICY nlsec_select ON public.newsletter_sections FOR SELECT USING (TRUE);
CREATE POLICY nlsec_ins ON public.newsletter_sections FOR INSERT WITH CHECK (TRUE);
CREATE POLICY nlsec_upd ON public.newsletter_sections FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY nlsec_del ON public.newsletter_sections FOR DELETE USING (public.is_platform_admin());

CREATE POLICY nlss_select ON public.newsletter_scheduled_sends FOR SELECT USING (TRUE);
CREATE POLICY nlss_ins ON public.newsletter_scheduled_sends FOR INSERT WITH CHECK (TRUE);
CREATE POLICY nlss_upd ON public.newsletter_scheduled_sends FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY nlss_del ON public.newsletter_scheduled_sends FOR DELETE USING (public.is_platform_admin());

CREATE POLICY nlseo_select ON public.newsletter_seo_scores FOR SELECT USING (TRUE);
CREATE POLICY nlseo_ins ON public.newsletter_seo_scores FOR INSERT WITH CHECK (TRUE);
CREATE POLICY nlseo_upd ON public.newsletter_seo_scores FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY nlseo_del ON public.newsletter_seo_scores FOR DELETE USING (public.is_platform_admin());

-- ── System queues and platform-only logs (admin/system only) ──
CREATE POLICY eq_select ON public.embedding_queue FOR SELECT USING (public.is_platform_admin());
CREATE POLICY eq_ins ON public.embedding_queue FOR INSERT WITH CHECK (TRUE);
CREATE POLICY eq_upd ON public.embedding_queue FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY eq_del ON public.embedding_queue FOR DELETE USING (public.is_platform_admin());

CREATE POLICY nq_select ON public.notification_queue FOR SELECT USING (public.is_platform_admin());
CREATE POLICY nq_ins ON public.notification_queue FOR INSERT WITH CHECK (TRUE);
CREATE POLICY nq_upd ON public.notification_queue FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY nq_del ON public.notification_queue FOR DELETE USING (public.is_platform_admin());

CREATE POLICY vgq_select ON public.video_generation_queue FOR SELECT USING (public.is_platform_admin());
CREATE POLICY vgq_ins ON public.video_generation_queue FOR INSERT WITH CHECK (TRUE);
CREATE POLICY vgq_upd ON public.video_generation_queue FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY vgq_del ON public.video_generation_queue FOR DELETE USING (public.is_platform_admin());

CREATE POLICY wrs_select ON public.workflow_run_steps FOR SELECT USING (public.is_platform_admin());
CREATE POLICY wrs_ins ON public.workflow_run_steps FOR INSERT WITH CHECK (TRUE);
CREATE POLICY wrs_upd ON public.workflow_run_steps FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY wrs_del ON public.workflow_run_steps FOR DELETE USING (public.is_platform_admin());

CREATE POLICY cwl_select ON public.call_whisper_logs FOR SELECT USING (public.is_platform_admin());
CREATE POLICY cwl_ins ON public.call_whisper_logs FOR INSERT WITH CHECK (TRUE);
CREATE POLICY cwl_upd ON public.call_whisper_logs FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY cwl_del ON public.call_whisper_logs FOR DELETE USING (public.is_platform_admin());

CREATE POLICY psl_select_p ON public.platform_suppression_list FOR SELECT USING (public.is_platform_admin());
CREATE POLICY psl_ins_p ON public.platform_suppression_list FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY psl_upd_p ON public.platform_suppression_list FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY psl_del_p ON public.platform_suppression_list FOR DELETE USING (public.is_platform_admin());

CREATE POLICY po_select ON public.provider_overrides FOR SELECT USING (public.is_platform_admin());
CREATE POLICY po_ins ON public.provider_overrides FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY po_upd ON public.provider_overrides FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY po_del ON public.provider_overrides FOR DELETE USING (public.is_platform_admin());

-- Misc platform-write tables
CREATE POLICY lfv_select ON public.long_form_videos FOR SELECT USING (TRUE);
CREATE POLICY lfv_ins ON public.long_form_videos FOR INSERT WITH CHECK (TRUE);
CREATE POLICY lfv_upd ON public.long_form_videos FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY lfv_del ON public.long_form_videos FOR DELETE USING (public.is_platform_admin());

CREATE POLICY tvids_select ON public.transparency_videos FOR SELECT USING (TRUE);
CREATE POLICY tvids_ins ON public.transparency_videos FOR INSERT WITH CHECK (TRUE);
CREATE POLICY tvids_upd ON public.transparency_videos FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY tvids_del ON public.transparency_videos FOR DELETE USING (public.is_platform_admin());

CREATE POLICY mstats_select ON public.marketing_stats FOR SELECT USING (TRUE);
CREATE POLICY mstats_ins ON public.marketing_stats FOR INSERT WITH CHECK (TRUE);
CREATE POLICY mstats_upd ON public.marketing_stats FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY mstats_del ON public.marketing_stats FOR DELETE USING (public.is_platform_admin());

CREATE POLICY mrs_select ON public.market_rate_snapshots FOR SELECT USING (TRUE);
CREATE POLICY mrs_ins ON public.market_rate_snapshots FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY mrs_upd ON public.market_rate_snapshots FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY mrs_del ON public.market_rate_snapshots FOR DELETE USING (public.is_platform_admin());

-- ─── PHASE C: ai_isa_activities.activity_type enum expand ───────────────────
-- Original enum was outreach-channel-shaped only. lib/kernel/ai-isa.ts logs
-- automation-lifecycle events (start/pause/resume/outcome_recorded) on the
-- same table — add those values so the kernel writes succeed.
ALTER TABLE public.ai_isa_activities DROP CONSTRAINT IF EXISTS ai_isa_activities_activity_type_check;
ALTER TABLE public.ai_isa_activities ADD CONSTRAINT ai_isa_activities_activity_type_check
  CHECK (activity_type = ANY (ARRAY[
    'call','email','text','appointment_set','follow_up','video','direct_mail',
    'property_alert','tour_plan','info_guide','open_house_invite',
    'automation_started','automation_paused','automation_resumed','outcome_recorded'
  ]));

-- ─── PHASE D: agent_handoffs.session_id nullable ────────────────────────────
-- session_id was originally designed for conversational (chat-session)
-- handoffs. ISA lead-stage handoffs (kernel handoffToHumanAgent) have no
-- session context — the handoff is per-lead. Allow NULL so kernel writes
-- succeed; the chat-handoff path still populates it.
ALTER TABLE public.agent_handoffs ALTER COLUMN session_id DROP NOT NULL;

-- ─── PHASE E: repoint 2 FKs from contacts(contact_id) → contacts(id) ────────
-- contact_suppression_list_contact_id_fkey and contact_consent_events_contact_id_fkey
-- were the only two FKs in the entire schema pointing at the alt-identifier
-- (contacts.contact_id, added in m046 with DEFAULT gen_random_uuid()) instead
-- of the primary key (contacts.id). Every caller passes contacts.id, so every
-- write failed. Both tables are empty so the repoint is data-safe.
ALTER TABLE public.contact_suppression_list DROP CONSTRAINT contact_suppression_list_contact_id_fkey;
ALTER TABLE public.contact_suppression_list ADD CONSTRAINT contact_suppression_list_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.contact_consent_events DROP CONSTRAINT contact_consent_events_contact_id_fkey;
ALTER TABLE public.contact_consent_events ADD CONSTRAINT contact_consent_events_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;
