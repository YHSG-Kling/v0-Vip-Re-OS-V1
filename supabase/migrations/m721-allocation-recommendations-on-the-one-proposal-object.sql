-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m721 — RESOURCE ALLOCATION RECOMMENDATIONS ON THE ONE PROPOSAL OBJECT (wave 106, lane 106A).
-- Owner: "Not automatically at first. Recommendation mode first." A recommendation (who should get this
-- lead / how to split this marketing budget) is an improvement_proposals row (m709, 104C) a HUMAN
-- approves — no second table. ADDITIVE widening of the two CHECKs, latest-migration superset rule
-- (wave 104 lesson 1): this file restates the FULL m709 lists plus the new values.
--   subject_kind + 'allocation'           (lib/kernel/improvement-proposals.ts PROPOSAL_SUBJECT_KINDS)
--   proposer     + 'resource_allocation'  (lib/kernel/improvement-proposals.ts PROPOSERS)
-- Writer: lib/kernel/resource-allocation.ts recordAllocationRecommendation → proposeImprovement.
-- AFTER APPLYING: regenerate scripts/check-vocabularies.ts (test:check-vocabulary mirrors both
-- constants) and restamp line 1 (one provenance line, dated). Apply in ONE part (two ALTERs, no data).

ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_subject_kind_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_subject_kind_check
  CHECK (subject_kind IN ('policy', 'prompt', 'variant', 'threshold', 'allocation'));

ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_proposer_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_proposer_check
  CHECK (proposer IN ('copy_learning', 'predictor_learning', 'prompt_calibrator', 'outcome_autopsy', 'human', 'media_intelligence', 'resource_allocation'));

COMMENT ON CONSTRAINT improvement_proposals_subject_kind_check ON public.improvement_proposals IS
  'm721 (wave 106A): + allocation — a resource allocation recommendation (lead assignment / marketing budget) a human approves; authority 6, never model-promoted.';
