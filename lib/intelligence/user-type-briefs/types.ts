/**
 * User-type Brief — common types.
 *
 * Every user_type gets a daily AI brief tailored to their daily flow:
 *   - agent          → existing generator (lib/intelligence/daily-briefing-generator.ts)
 *   - broker         → brokerage health + critical items
 *   - TC             → closings + at-risk deals + missing docs
 *   - compliance_officer → triage queue + violations
 *   - lender         → stuck files + closings approaching
 *   - vendor         → open jobs + payment due + overdue deliverables
 *   - contact        → persona-specific (separate per-portal flow)
 *
 * All briefs return the same shape so a single `<TodaysFocusCard>` component
 * renders any of them without per-user-type branching.
 */

export type Severity = "critical" | "high" | "medium" | "low"

export interface BriefPriority {
  /** Stable id used for action tracking (e.g., "deal-risk-{transaction_id}") */
  id: string
  title: string
  body: string
  severity: Severity
  /** Optional CTAs surfaced inline on the priority card */
  ctas?: Array<{
    label: string
    href?: string
    actionType?: string
    actionPayload?: Record<string, unknown>
  }>
}

export interface BriefMetric {
  label: string
  value: string | number
  trend?: "up" | "down" | "flat"
  /** Optional click-through to drilldown */
  href?: string
}

export interface UserTypeBrief {
  userId: string
  userType: string
  brokerageId: string | null
  briefingDate: string
  /** 1-2 sentence AI-generated synthesis */
  summary: string
  /** Top 3 priorities the user should tackle today */
  priorities: BriefPriority[]
  /** KPI strip — 3-5 metrics relevant to the user_type */
  metrics: BriefMetric[]
  generatedAt: string
  /** Cache hit flag — true if returned from cache */
  cached?: boolean
}
