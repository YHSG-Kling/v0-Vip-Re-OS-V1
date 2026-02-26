// ─── MULTI-FACTOR SCORER ──────────────────────────────────────────────────────
export type { LeadScoringFactors, ScoringResult } from "./multi-factor-scorer"
export { calculateLeadScore } from "./multi-factor-scorer"

// ─── ROUTING EVALUATOR ────────────────────────────────────────────────────────
export type { RoutingPolicy, RoutingDecision } from "./routing-evaluator"
export { evaluateRoutingEligibility } from "./routing-evaluator"

// ─── AGENT SELECTOR ───────────────────────────────────────────────────────────
export type { AgentSelectionResult } from "./agent-selector"
export { selectAgentForLead } from "./agent-selector"

// ─── SLA MONITOR ──────────────────────────────────────────────────────────────
export type { SLAStatus } from "./sla-monitor"
export { evaluateSLA, logEscalation } from "./sla-monitor"

// ─── SLA ESCALATION ───────────────────────────────────────────────────────────
export type { SLARule, SLABreachResult } from "./sla-escalation"
export { evaluateSLABreach } from "./sla-escalation"

// ─── PROMOTION READINESS ──────────────────────────────────────────────────────
export type { PromotionReadinessResult } from "./promotion-readiness"
export { evaluatePromotionReadiness } from "./promotion-readiness"
