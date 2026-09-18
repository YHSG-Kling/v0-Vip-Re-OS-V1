// ─── MULTI-FACTOR SCORER ──────────────────────────────────────────────────────
export type { LeadScoringFactors, ScoringResult } from "./multi-factor-scorer"
export { calculateLeadScore } from "./multi-factor-scorer"

// ─── ROUTING EVALUATOR ────────────────────────────────────────────────────────
export type { RoutingPolicy, RoutingDecision } from "./routing-evaluator"
export { evaluateRoutingEligibility } from "./routing-evaluator"

// ─── AGENT SELECTOR ───────────────────────────────────────────────────────────
// selectAgentForLead / agent-selector.ts removed. It was a THIRD agent-picking
// implementation that never read assignment_rules, so the broker's configured
// method was bypassed on the governance path entirely; it sorted candidates by
// id.localeCompare and took the first, then reported selectionMethod
// 'load_balanced' in the activities ledger — a false audit entry its own comment
// admitted ("In production, you'd query leads table for counts"). Its one real
// idea, preferring a specialist, is now the 'specialization' rule_type a broker
// can choose. lib/lead-assignment/assignment-engine.ts resolveAgentByRules is
// the one resolver.

// ─── SLA MONITOR ──────────────────────────────────────────────────────────────
// `SLAPosture` / `APPROACHING_SLA_WINDOW_HOURS` were MERGED onto evaluateSLA on
// 2026-08-25 from the retired duplicate lib/agent-orchestration/
// agent-activity-monitor.ts — see the tombstone at
// lib/agent-orchestration/index.ts for what went where and why.
export type { SLAStatus, SLAPosture } from "./sla-monitor"
export { evaluateSLA, logEscalation, APPROACHING_SLA_WINDOW_HOURS } from "./sla-monitor"

// ─── SLA ESCALATION ───────────────────────────────────────────────────────────
export type { SLARule, SLABreachResult } from "./sla-escalation"
export { evaluateSLABreach } from "./sla-escalation"

// ─── PROMOTION READINESS ──────────────────────────────────────────────────────
export type { PromotionReadinessResult } from "./promotion-readiness"
export { evaluatePromotionReadiness } from "./promotion-readiness"
