-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m733 — THE STRATEGY LIBRARY'S APPROVED GAPS BECOME CATALOGUE CAPABILITIES (wave 108, lane 108H).
-- Owner (wave 108 ruling 2): "the strategy library's named gaps are approved to BUILD (recruiting
-- capability, ads capability, lender pre-approval handoff) on survivors".
--
-- Code (already written, depends on THIS migration):
--   · lib/agentic-os/app-capability-registry.ts — three APP_CAPABILITY_REGISTRY keys:
--       recruit_outreach (recruiting_manager), ad_campaign_launch (ads_manager),
--       lender_preapproval_handoff (shopping_agent) — owners in lib/agentic-os/capability-ownership.ts.
--   · lib/kernel/manager-delegation.ts — DELEGATION_WORKERS works them on their survivors
--       (recruit-outreach-producer / lib/kernel/ads.ts createAdCampaign / lender-linkage recordLenderReferral),
--       and admits a MISSION OWNER'S WORK ORDER (requesting = assigned) ONLY for those three capabilities
--       on a mission that manager owns.
--
-- PART 1 (constraints) — additive widening only; no row changes. Every existing row satisfies both
-- new definitions (the capability list is a superset; the not-self rule only ADMITS more rows), so the
-- constraints are added VALID.
--
-- WIDENING NOTE for the integrator: manager_delegations_requested_capability_check is the m712 list +
-- three keys. If another wave-108 lane also widens it, the HIGHEST-numbered migration must carry the
-- superset (LANE_RULES wave 104/106 lesson). Regenerate scripts/check-vocabularies.ts after applying.
-- INTEGRATED: m730 (lane 108E) widened the same CHECK with three evidence-report keys, so this file —
-- the highest-numbered definer — carries the SUPERSET (m712 + m730's three + these three = 35 keys).

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
    'campaign_performance_report', 'ads_performance_report', 'listing_demand_report',
    'recruit_outreach', 'ad_campaign_launch', 'lender_preapproval_handoff'));

-- A manager still never asks ITSELF — except the mission owner's WORK ORDER for a capability with a
-- worker on its survivor, and only inside a mission (the service also checks the mission's owner).
ALTER TABLE public.manager_delegations DROP CONSTRAINT IF EXISTS manager_delegations_not_self_check;
ALTER TABLE public.manager_delegations ADD CONSTRAINT manager_delegations_not_self_check
  CHECK (
    requesting_manager <> assigned_manager
    OR (mission_id IS NOT NULL AND requested_capability IN ('recruit_outreach', 'ad_campaign_launch', 'lender_preapproval_handoff'))
  );

-- PART 2 (comment) — separate call.
COMMENT ON CONSTRAINT manager_delegations_not_self_check ON public.manager_delegations IS
  'm733 (wave 108): requesting <> assigned, except a mission owner''s work order for a capability worked on its survivor (lib/kernel/manager-delegation.ts DELEGATION_WORKERS).';
