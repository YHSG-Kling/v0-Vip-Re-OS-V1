-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m732 — SELF-OPTIMIZING MANAGER TEAMS, BOUNDED (wave 108, lane 108G).
-- Owner: "managers improve strategies together — campaign sequencing, model routing, creative choice, education
-- interventions, follow-up timing, provider selection, property recommendations — NEVER authority policies,
-- financial rules or compliance boundaries."
--
-- SURVIVOR: improvement_proposals (m709 / m721 / m726) stays the ONE proposal object. No new table, no new column:
--   · the team's co-proposal rides proposed_change.optimization (jsonb: class, cycle_id, owner, co_proposers,
--     managers, evidence_by_manager) — written only through lib/kernel/improvement-proposals.ts proposeImprovement
--     by lib/kernel/self-optimization.ts runTeamOptimizationCycle; read by classifyProposalSurface at every step.
--   · PART A widens the proposer CHECK with `team_optimization` as the SUPERSET of m726 (latest-definer rule: if
--     another wave-108 lane also widens this CHECK, the integrator restates the union in the highest number).
--   · PART B CHECKs the stored optimization class against the code constant OPTIMIZATION_CLASSES
--     (lib/kernel/self-optimization.ts) — the one vocabulary (CLAUDE.md §6). Existing rows carry no block → valid.
-- Apply in TWO parts (wave 98 rule). AFTER APPLYING: regenerate scripts/check-vocabularies.ts and restamp line 1.

-- ══════════════════════════════ PART A — proposer vocabulary (superset of m726) ══════════════════════════════
ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_proposer_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_proposer_check
  CHECK (proposer IN ('copy_learning', 'predictor_learning', 'prompt_calibrator', 'outcome_autopsy', 'human', 'media_intelligence', 'resource_allocation', 'strategy_learning', 'team_optimization', 'experimentation'));

-- INTEGRATION (wave 108): m731 (108F) and this file (108G) both widened improvement_proposals in parallel; as the
-- HIGHEST-numbered definer this file restates the SUPERSET of both CHECKs (proposer + experimentation;
-- subject_kind + experiment) so the latest definer equals the code constants.
ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_subject_kind_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_subject_kind_check
  CHECK (subject_kind IN ('policy', 'prompt', 'variant', 'threshold', 'allocation', 'strategy', 'experiment'));

-- ══════════════════════════════ PART B — the optimization class (jsonb, CHECKed where it is stored) ══════════════
ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_optimization_class_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_optimization_class_check
  CHECK (
    (proposed_change -> 'optimization') IS NULL
    OR (proposed_change -> 'optimization' ->> 'class') IN ('campaign_sequencing', 'model_routing', 'creative_choice', 'education_intervention', 'followup_timing', 'provider_selection', 'property_recommendation')
  ) NOT VALID;
ALTER TABLE public.improvement_proposals VALIDATE CONSTRAINT improvement_proposals_optimization_class_check;

COMMENT ON CONSTRAINT improvement_proposals_optimization_class_check ON public.improvement_proposals IS
  'm732 (wave 108G): proposed_change.optimization.class is one of lib/kernel/self-optimization.ts OPTIMIZATION_CLASSES. A team proposal on a FORBIDDEN surface (authority / financial / compliance / outside the allowed list) is refused by the kernel before it reaches this table.';
