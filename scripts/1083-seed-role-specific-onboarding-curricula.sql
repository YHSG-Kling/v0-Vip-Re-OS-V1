-- ===========================================================================
-- 1083-seed-role-specific-onboarding-curricula.sql
--
-- All 42 platform-default onboarding steps had target_role=NULL — meaning
-- brokers, admins, TCs, and compliance officers were getting the agent
-- curriculum (Day 1: license upload, Day 2: TCPA, etc) which makes no sense
-- for their roles. The kernel filter is:
--   target_role IS NULL OR target_role CONTAINS user_role
-- so NULL meant "show to everyone".
--
-- This migration:
--   1) Tags the existing 42 platform steps as agent-only.
--   2) Seeds broker (8 steps), admin (6 steps), TC (5 steps), and
--      compliance_officer (5 steps) curricula. Every step links to a real
--      route in the app — no demo content.
--
-- Categories CHECK on onboarding_steps allows only:
--   {system_setup, training, practice, compliance, certification}
--
-- APPLIED VIA: supabase apply_migration "seed_role_specific_onboarding_curricula_v2"
-- ===========================================================================

UPDATE public.onboarding_steps
SET target_role = ARRAY['agent']::text[],
    updated_at  = now()
WHERE brokerage_id IS NULL
  AND target_role IS NULL;

-- BROKER
INSERT INTO public.onboarding_steps
  (brokerage_id, day_number, step_order, step_key, step_name, category, required,
   estimated_minutes, instructions, target_role)
SELECT * FROM (VALUES
  (NULL::uuid, 1, 10, 'broker_d1_brokerage_profile',
   'Complete brokerage profile', 'system_setup', true, 10,
   'Visit /dashboard/admin to set your brokerage name, license number, EIN, and address. This data drives every contract, disclosure, and compliance flag downstream.',
   ARRAY['broker']::text[]),
  (NULL::uuid, 1, 20, 'broker_d1_brand_setup',
   'Upload brand assets', 'system_setup', true, 15,
   'Visit /dashboard/admin/brand to upload your logo, set brand colors, and configure brand voice. Marketing Studio uses these to render every video, photo, and email on-brand.',
   ARRAY['broker']::text[]),
  (NULL::uuid, 1, 30, 'broker_d1_provider_stack',
   'Connect your provider stack', 'system_setup', true, 25,
   'Visit /dashboard/onboarding/tech-stack to connect e-sign (Dotloop/SkySlope/DocuSign), email (SendGrid), SMS (Twilio), calendar, and CRM. At least one of each is required.',
   ARRAY['broker']::text[]),
  (NULL::uuid, 2, 10, 'broker_d2_required_docs',
   'Configure required documents per state', 'compliance', true, 15,
   'Visit /dashboard/settings/required-documents to seed the state-specific required-document checklist for every transaction. Pre-built presets exist for TX, CA, FL, NY, IL, GA, AZ, CO, WA, NC.',
   ARRAY['broker']::text[]),
  (NULL::uuid, 2, 20, 'broker_d2_compliance_team',
   'Assign compliance officers and TCs', 'practice', true, 10,
   'Visit /dashboard/admin/users/invitations to invite your compliance officers and transaction coordinators. They handle the compliance review queue and packet finalization.',
   ARRAY['broker']::text[]),
  (NULL::uuid, 3, 10, 'broker_d3_invite_agents',
   'Invite your first agents', 'practice', true, 10,
   'Visit /dashboard/admin/users/invitations to invite agents. Each agent gets their own onboarding curriculum and can start working leads immediately after they finish it.',
   ARRAY['broker']::text[]),
  (NULL::uuid, 3, 20, 'broker_d3_brokerage_dashboard_tour',
   'Tour the brokerage dashboard', 'training', false, 10,
   'Visit /dashboard/brokerage to review the brokerage-wide deal pipeline, agent fatigue, deal health, and intelligence rollups. This is your daily operating view.',
   ARRAY['broker']::text[]),
  (NULL::uuid, 3, 30, 'broker_d3_compliance_queue_tour',
   'Tour the compliance queue', 'training', false, 10,
   'Visit /dashboard/compliance/queue to see flagged offers, packet blockers, EM receipt watchers, and pending TC reviews across every active transaction.',
   ARRAY['broker']::text[])
) AS s
WHERE NOT EXISTS (SELECT 1 FROM public.onboarding_steps o WHERE o.step_key = s.column4 AND o.brokerage_id IS NULL);

-- ADMIN
INSERT INTO public.onboarding_steps
  (brokerage_id, day_number, step_order, step_key, step_name, category, required,
   estimated_minutes, instructions, target_role)
SELECT * FROM (VALUES
  (NULL::uuid, 1, 10, 'admin_d1_admin_dashboard',
   'Tour the admin dashboard', 'training', true, 10,
   'Visit /dashboard/admin to learn the admin oversight layer — users, billing, AI usage, provider health, feature governance, and learning modules all live here.',
   ARRAY['admin']::text[]),
  (NULL::uuid, 1, 20, 'admin_d1_user_management',
   'Manage user invitations', 'practice', true, 10,
   'Visit /dashboard/admin/users/invitations to invite, suspend, and audit users across all roles (agent, broker, TC, compliance officer, vendor, lender).',
   ARRAY['admin']::text[]),
  (NULL::uuid, 2, 10, 'admin_d2_assignment_rules',
   'Configure lead and listing assignment rules', 'system_setup', true, 15,
   'Visit /dashboard/admin/assignment-rules to set how incoming leads and listings are routed to agents (round-robin, by neighborhood, by lifetime customer status).',
   ARRAY['admin']::text[]),
  (NULL::uuid, 2, 20, 'admin_d2_provider_intelligence',
   'Review provider health', 'training', false, 10,
   'Visit /dashboard/admin/provider-intelligence to monitor e-sign, email, SMS, MLS, and AI provider uptime and cost. Set up alerts before agents notice failures.',
   ARRAY['admin']::text[]),
  (NULL::uuid, 3, 10, 'admin_d3_billing_overview',
   'Verify billing setup', 'system_setup', true, 10,
   'Visit /dashboard/admin/billing to confirm subscription tier, payment method, and seat counts. Required before agents can use paid AI features.',
   ARRAY['admin']::text[]),
  (NULL::uuid, 3, 20, 'admin_d3_approvals_queue',
   'Tour the approvals queue', 'training', false, 10,
   'Visit /dashboard/admin/approvals to see content, video, and campaign items awaiting admin sign-off across the brokerage.',
   ARRAY['admin']::text[])
) AS s
WHERE NOT EXISTS (SELECT 1 FROM public.onboarding_steps o WHERE o.step_key = s.column4 AND o.brokerage_id IS NULL);

-- TC
INSERT INTO public.onboarding_steps
  (brokerage_id, day_number, step_order, step_key, step_name, category, required,
   estimated_minutes, instructions, target_role)
SELECT * FROM (VALUES
  (NULL::uuid, 1, 10, 'tc_d1_role_intro',
   'Learn the TC role and authority', 'training', true, 10,
   'Review your authority matrix at /dashboard/settings/team/tc. You finalize packets, dispatch e-sign envelopes, and clear compliance flags. You do NOT negotiate terms.',
   ARRAY['TC']::text[]),
  (NULL::uuid, 1, 20, 'tc_d1_handoffs_cockpit',
   'Tour the agent handoffs cockpit', 'training', true, 10,
   'Visit /dashboard/communications/handoffs to see contacts the AI ISA has handed off because urgency, sentiment, or a pending draft requires human action.',
   ARRAY['TC']::text[]),
  (NULL::uuid, 2, 10, 'tc_d2_compliance_queue',
   'Triage the compliance queue', 'compliance', true, 15,
   'Visit /dashboard/compliance/queue daily. Triage flagged offers, missing EM receipts, packet blockers, and pending TC reviews. Document every action with notes.',
   ARRAY['TC']::text[]),
  (NULL::uuid, 2, 20, 'tc_d2_packet_finalization',
   'Practice packet finalization', 'practice', true, 15,
   'When a buyer-signed offer is ready, the agent submits to compliance. You run the packet scan, attach missing docs, and dispatch the seller-signed envelope through the configured e-sign provider.',
   ARRAY['TC']::text[]),
  (NULL::uuid, 3, 10, 'tc_d3_required_docs',
   'Understand state-specific required docs', 'compliance', true, 10,
   'Visit /dashboard/settings/required-documents to see the required-document checklist driving every packet audit. Your job is to clear the missing docs list.',
   ARRAY['TC']::text[])
) AS s
WHERE NOT EXISTS (SELECT 1 FROM public.onboarding_steps o WHERE o.step_key = s.column4 AND o.brokerage_id IS NULL);

-- COMPLIANCE OFFICER
INSERT INTO public.onboarding_steps
  (brokerage_id, day_number, step_order, step_key, step_name, category, required,
   estimated_minutes, instructions, target_role)
SELECT * FROM (VALUES
  (NULL::uuid, 1, 10, 'comp_d1_dashboard',
   'Tour the compliance dashboard', 'training', true, 10,
   'Visit /dashboard/compliance to see the compliance posture across every active offer, listing, transaction, and document. This is your daily home base.',
   ARRAY['compliance_officer']::text[]),
  (NULL::uuid, 1, 20, 'comp_d1_queue_triage',
   'Triage the compliance queue', 'compliance', true, 15,
   'Visit /dashboard/compliance/queue to triage flagged offers, missing-doc audits, and EM receipt watchers. Action every high/critical flag within SLA.',
   ARRAY['compliance_officer']::text[]),
  (NULL::uuid, 2, 10, 'comp_d2_flag_severity',
   'Master flag severity and routing', 'compliance', true, 10,
   'Low and medium flags log silently and route to the TC. High and critical flags fan out via NotificationService to TC, compliance manager, and you — verify your notification preferences are correct.',
   ARRAY['compliance_officer']::text[]),
  (NULL::uuid, 2, 20, 'comp_d2_scanner_output',
   'Review document scanner output', 'compliance', true, 15,
   'Open any offer with uploaded documents. The universal scanner classifies, extracts fields, and stamps key dates (EM due, contract date). Validate the auto-populated lender and title participants on each transaction.',
   ARRAY['compliance_officer']::text[]),
  (NULL::uuid, 3, 10, 'comp_d3_required_docs',
   'Audit the required-documents config', 'compliance', true, 10,
   'Visit /dashboard/settings/required-documents to verify the brokerage required-document checklist matches your state and brokerage policy. Add missing items before the next deal closes.',
   ARRAY['compliance_officer']::text[])
) AS s
WHERE NOT EXISTS (SELECT 1 FROM public.onboarding_steps o WHERE o.step_key = s.column4 AND o.brokerage_id IS NULL);
