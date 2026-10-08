-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m740 — OPTIMIZATION CLASS BREADTH (wave 137, lane 137E).
-- Owner (wave 137 BREADTH): the self-optimizing manager teams were built listing/lead-centric; expand them to the
-- full OS WHERE an evaluator + rollback + reader can be real.
--
-- SURVIVOR: improvement_proposals.proposed_change.optimization.class, CHECKed by m732 against
-- lib/kernel/self-optimization.ts OPTIMIZATION_CLASSES. This file RESTATES THE FULL LIST (m732's seven + the one new
-- class) — an additive widening, never a narrowing:
--   transaction_reminder_timing — owner deal_coordinator (co-proposer compliance_officer on closing_money_and_risk);
--     evaluator deadline_outcomes (transaction_deadlines missed vs resolved, tenant-pinned, 180d); writer / rollback
--     mergeBrokerageSettings:optimization_tuning.deadline_reminder_hours; reader lib/kernel/calendar-deadline-watcher.ts.
-- No new table, no new column. Existing rows are unaffected (every stored class is still in the list).
--
-- SUPERSET RISK: if another wave-137 lane also widens improvement_proposals_optimization_class_check, the integrator
-- restates the UNION in the highest-numbered migration (the proofs read the LATEST defining migration).
-- Apply in TWO parts (wave 98 rule) — ONE statement per MCP call (wave 108 lesson). AFTER APPLYING: regenerate
-- scripts/check-vocabularies.ts and restamp line 1.

-- ══════════════════════════════ PART A — the widened CHECK (atomic swap, one statement) ══════════════════════════
ALTER TABLE public.improvement_proposals
  DROP CONSTRAINT IF EXISTS improvement_proposals_optimization_class_check,
  ADD CONSTRAINT improvement_proposals_optimization_class_check
  CHECK (
    (proposed_change -> 'optimization') IS NULL
    OR (proposed_change -> 'optimization' ->> 'class') IN ('campaign_sequencing', 'model_routing', 'creative_choice', 'education_intervention', 'followup_timing', 'provider_selection', 'property_recommendation', 'transaction_reminder_timing')
  ) NOT VALID;

-- ══════════════════════════════ PART B — validate + document ═════════════════════════════════════════════════════
ALTER TABLE public.improvement_proposals VALIDATE CONSTRAINT improvement_proposals_optimization_class_check;

COMMENT ON CONSTRAINT improvement_proposals_optimization_class_check ON public.improvement_proposals IS
  'm740 (wave 137E, superset of m732): proposed_change.optimization.class is one of lib/kernel/self-optimization.ts OPTIMIZATION_CLASSES (+ transaction_reminder_timing). A team proposal on a FORBIDDEN surface (authority / financial / compliance / outside the allowed list) is refused by the kernel before it reaches this table.';
