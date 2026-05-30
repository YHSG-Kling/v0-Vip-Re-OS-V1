-- Migration 030: Add brokerage_id to 44 more multi-tenant tables that were
-- orphans from the original tenant model.
--
-- Continuation of migration 029. Same rationale: superadmin billing rollups,
-- fair-use enforcement, and cost attribution all need every tenant-relevant
-- table to carry brokerage_id directly. Without this, rollup queries have
-- to JOIN against contacts/agents/etc just to resolve the brokerage —
-- which falls over when those parent rows are deleted, the contact moves
-- brokerages, or the table has no FK back to a parent at all.
--
-- All 44 tables were empty in prod at apply time, so columns are added
-- NULLABLE with no backfill (ON DELETE SET NULL FK to brokerages, plus
-- per-table index on brokerage_id for the planner). RLS is enabled on
-- every table and a brokerage-scoped tenant policy is installed:
--   USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
-- Service role bypasses RLS for cron / background work.
--
-- Applied: 2026-05-18

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'agent_badges',
      'business_expenses',
      'client_detailed_personas',
      'closing_disclosure',
      'closing_notifications',
      'comp_risk_flags',
      'contact_portal_modules',
      'content_performance_tracking',
      'conversation_insights',
      'conversation_logs',
      'credit_conversation_logs',
      'credit_partner_referrals',
      'credit_status',
      'deal_health_snapshots',
      'document_checklist',
      'google_search_activity',
      'idx_property_interactions',
      'journey_states',
      'journey_task_completions',
      'lead_behavioral_data',
      'lead_engagement_scores',
      'lead_idx_property_interactions',
      'lead_intelligence',
      'lead_motivated_seller_signals',
      'lead_osint_data',
      'lead_people_data',
      'lead_property_ownership',
      'lead_property_searches',
      'lead_scores',
      'listing_engagement',
      'listing_metrics',
      'listing_photos',
      'messages',
      'nextdoor_activity',
      'open_house_rsvp_tracking',
      'property_feedback',
      'property_upgrades',
      'real_estate_events',
      'sequence_step_executions',
      'smart_assistant_suggestions',
      'smart_landing_sessions',
      'transparency_updates',
      'vendor_jobs',
      'video_engagement_events'
    ])
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL',
      t
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I(brokerage_id)',
      'idx_' || t || '_brokerage', t
    );
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
