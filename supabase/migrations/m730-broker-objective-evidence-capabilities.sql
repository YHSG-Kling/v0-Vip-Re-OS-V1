-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- BROKER OBJECTIVES — the evidence capabilities (wave 108, lane 108E). ADDITIVE WIDENING ONLY.
--
-- An INVESTIGATION objective ("find out why listing appointments dropped last month") is a mission the
-- Mission Controller runs by asking each participating manager for its EVIDENCE CHECK through a
-- manager_delegation (lib/kernel/manager-delegation.ts, 105A). A delegation's capability must be an
-- APP_CAPABILITY_REGISTRY key the ASSIGNED manager owns (CAPABILITY_MANAGER). Three participants owned no
-- read capability — the Ads Manager owned NONE at all — so the delegation to them was impossible. Lane
-- 108E adds three read-only, kernel-only catalogue keys (lib/agentic-os/app-capability-registry.ts):
--   · campaign_performance_report → campaign_orchestrator
--   · ads_performance_report      → ads_manager
--   · listing_demand_report       → listing_concierge
-- and this file widens manager_delegations_requested_capability_check (m712) to the catalogue's keys.
-- It is the LATEST DEFINER of that CHECK — scripts/manager-delegation-guard.ts H13 reads the latest
-- defining migration, never m712 by name. If another wave-108 lane widens the same CHECK, the integrator
-- writes the SUPERSET as the highest-numbered migration.
--
-- Until applied: requestDelegation for the three new keys is refused by the CHECK (insert_refused); the
-- investigation still returns its evidence report and NAMES each refused delegation as a blind spot —
-- it never reports the check as delegated.
--
-- After applying: regenerate the vocabulary cache (scripts/check-vocabularies.ts — generated, never
-- hand-edited) so check-vocabulary-guard holds code and database in agreement.

-- Part 1 (the only part): the widened CHECK. Existing rows all satisfy the superset (no row can carry a
-- key that is new here), so the constraint validates immediately.
ALTER TABLE public.manager_delegations DROP CONSTRAINT IF EXISTS manager_delegations_requested_capability_check;
ALTER TABLE public.manager_delegations ADD CONSTRAINT manager_delegations_requested_capability_check
  CHECK (requested_capability IN (
    'lead_search', 'contact_get', 'cma_generate', 'appointment_schedule', 'transaction_advance',
    'listing_publish', 'isa_qualify', 'lead_create', 'newsletter_send', 'blog_publish',
    'marketing_campaign_create', 'content_repurpose', 'social_post_publish', 'report_generate',
    'report_export', 'education_path_get', 'education_assign', 'portal_milestones_get',
    'review_request_send', 'inbox_reply_send', 'podcast_publish', 'direct_mail_send',
    'video_distribute', 'gift_send', 'handwritten_note_send', 'connectivity_scan',
    'payment_transfer', 'accounting_sync', 'listing_appointment_prep',
    'campaign_performance_report', 'ads_performance_report', 'listing_demand_report'));
