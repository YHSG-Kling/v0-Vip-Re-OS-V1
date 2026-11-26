-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m744 — LAW-RULE SELF-HEALING + the compliance / coaching capabilities (wave 138, lane 138C).
-- Owner (wave 138): "when a federal or state real-estate law rule is missing or outdated … the system researches it
-- (cited primary sources), drafts the rule into the compliance-rules survivor, and resolves it: a STRICTER-ONLY
-- addition may auto-enable in warn/flag mode with evidence; anything that LOOSENS a rule, blocks money, or is
-- ambiguous goes to the compliance officer (human)."
--
-- SURVIVORS (no new table):
--   · state_protected_classes — the jurisdiction-keyed rule rows lib/compliance-rules/state-fair-housing.ts evaluates.
--     PART 1 adds the LAW-RULE REGISTRY columns (lib/compliance-rules/law-rule-registry.ts projects them):
--       rule_scope, source_citations, effective_date, last_verified_at, enforcement_mode, provenance, evidence.
--     Writers: lib/kernel/law-rule-healing.ts runLawRuleHealing (warn auto-enable, verification) and
--     applyLawRuleProposal (a compliance officer's approved proposal). Readers: the registry view + the evaluator
--     (enforcement_mode warn → low severity; rule_scope gates the class-name check). Existing rows take the
--     defaults (advertising / enforce / seed) — behaviour unchanged.
--   · improvement_proposals — PART 2 widens subject_kind with `law_rule` and proposer with `law_rule_healing`.
--   · manager_delegations — PART 2 widens requested_capability with `compliance_review` (compliance_officer) and
--     `agent_coaching_assign` (recruiting_manager), and the not-self work-order exception with both.
--
-- SUPERSET NOTES FOR THE INTEGRATOR (wave 104/106/108 rule — the HIGHEST-numbered definer carries the union):
--   · manager_delegations_requested_capability_check = m733's 35 keys + the two above (37). If 138A/B/D/E/F also
--     widens it, restate the union in the highest-numbered migration.
--   · improvement_proposals_*_check = m732's lists + law_rule / law_rule_healing (code order: PROPOSAL_SUBJECT_KINDS /
--     PROPOSERS in lib/kernel/improvement-proposals.ts). If another lane widens them, the highest number restates both.
-- AFTER APPLYING: regenerate scripts/check-vocabularies.ts (state_protected_classes, improvement_proposals,
-- manager_delegations) and scripts/schema-snapshot.ts; restamp line 1.
-- Apply in TWO parts (wave 98 rule) — one statement per execute_sql call (wave 108 lesson).

-- ══════════════════════════════ PART 1 — registry columns on the rule survivor ══════════════════════════════
ALTER TABLE public.state_protected_classes
  ADD COLUMN IF NOT EXISTS rule_scope text NOT NULL DEFAULT 'advertising',
  ADD COLUMN IF NOT EXISTS source_citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS effective_date date,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS enforcement_mode text NOT NULL DEFAULT 'enforce',
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.state_protected_classes DROP CONSTRAINT IF EXISTS state_protected_classes_rule_scope_check,
  ADD CONSTRAINT state_protected_classes_rule_scope_check
  CHECK (rule_scope IN ('advertising', 'communications', 'disclosures', 'agency', 'wire_fraud', 'privacy', 'licensing'));

ALTER TABLE public.state_protected_classes DROP CONSTRAINT IF EXISTS state_protected_classes_enforcement_mode_check,
  ADD CONSTRAINT state_protected_classes_enforcement_mode_check
  CHECK (enforcement_mode IN ('enforce', 'warn'));

ALTER TABLE public.state_protected_classes DROP CONSTRAINT IF EXISTS state_protected_classes_provenance_check,
  ADD CONSTRAINT state_protected_classes_provenance_check
  CHECK (provenance IN ('seed', 'law_rule_healing', 'compliance_officer'));

-- The healing loop may only ever ADD a warn row: a row it wrote is never enforce-mode (a compliance officer's
-- approval re-stamps provenance to compliance_officer when it promotes the row to enforce).
ALTER TABLE public.state_protected_classes DROP CONSTRAINT IF EXISTS state_protected_classes_healing_is_warn_check,
  ADD CONSTRAINT state_protected_classes_healing_is_warn_check
  CHECK (provenance <> 'law_rule_healing' OR enforcement_mode = 'warn');

-- ══════════════════════════════ PART 2 — vocabularies (supersets) ══════════════════════════════
ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_proposer_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_proposer_check
  CHECK (proposer IN ('copy_learning', 'predictor_learning', 'prompt_calibrator', 'outcome_autopsy', 'human', 'media_intelligence', 'resource_allocation', 'strategy_learning', 'team_optimization', 'experimentation', 'law_rule_healing'));

ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_subject_kind_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_subject_kind_check
  CHECK (subject_kind IN ('policy', 'prompt', 'variant', 'threshold', 'allocation', 'strategy', 'experiment', 'law_rule'));

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
    'recruit_outreach', 'ad_campaign_launch', 'lender_preapproval_handoff',
    'compliance_review', 'agent_coaching_assign'));

ALTER TABLE public.manager_delegations DROP CONSTRAINT IF EXISTS manager_delegations_not_self_check;
ALTER TABLE public.manager_delegations ADD CONSTRAINT manager_delegations_not_self_check
  CHECK (
    requesting_manager <> assigned_manager
    OR (mission_id IS NOT NULL AND requested_capability IN ('recruit_outreach', 'ad_campaign_launch', 'lender_preapproval_handoff', 'compliance_review', 'agent_coaching_assign'))
  );

COMMENT ON COLUMN public.state_protected_classes.enforcement_mode IS
  'm744 (wave 138C): warn = flag at low severity (never a fail / block) — the law-rule healing loop''s stricter-only auto-enable; enforce = the row''s own severity (seed rows, or a compliance officer''s approval).';
