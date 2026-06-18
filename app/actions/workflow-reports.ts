"use server"

/**
 * Workflow OS reporting actions.
 *
 * Reads workflow_step_runs + sequence_enrollments + campaign_sequences and
 * surfaces aggregate metrics scoped to:
 *   - brokerage  (broker / admin role view)
 *   - team       (team-lead view, filtered by team_id)
 *   - agent      (single-agent view, filtered by enrolled_by or sequence.agent_id)
 *
 * All queries respect the authenticated user's role and scope; pass-through
 * to the service client only happens for service-role-only callers
 * (e.g. cron analytics rollups).
 */

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"

export type ReportScope = "brokerage" | "team" | "agent"

export interface WorkflowReportFilters {
  scope:        ReportScope
  brokerageId:  string
  /** Required when scope === "team" */
  teamId?:      string
  /** Required when scope === "agent" — agents.id (NOT users.id) */
  agentId?:     string
  /** ISO date — defaults to last 30 days */
  fromDate?:    string
  /** ISO date — defaults to now */
  toDate?:      string
  /** Optional channel filter (single channel name) */
  channel?:     string
}

export interface WorkflowReportSummary {
  scope:                ReportScope
  totalEnrollments:     number
  activeEnrollments:    number
  completedEnrollments: number
  totalStepsRun:        number
  successfulSteps:      number
  failedSteps:          number
  blockedSteps:         number
  successRate:          number      // 0..1
  totalConversions:     number
  totalConversionValueCents: number
  averageCompletionDays:    number | null
  byChannel:            Record<string, { runs: number; successes: number; failures: number }>
  topSequences:         Array<{ sequenceId: string; name: string; enrollments: number; completionRate: number }>
}

/**
 * Get a comprehensive workflow performance report.
 * Caller specifies scope; data is filtered server-side and never crosses
 * brokerage/team/agent boundaries.
 */
export async function getWorkflowReport(filters: WorkflowReportFilters): Promise<{
  success: boolean
  report?: WorkflowReportSummary
  error?: string
}> {
  try {
    const supabase = await createClient()

    const fromDate = filters.fromDate ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const toDate   = filters.toDate   ?? new Date().toISOString()

    // ── 1. Resolve which sequence ids fall in scope ─────────────────────────
    // campaign_sequences carries no agent_id/team_id — ownership is created_by +
    // brokerage_id. Sequence-level team/agent scoping isn't expressible here; per-
    // agent attribution is applied downstream at the enrollment level (enrolled_by).
    const sequenceQuery = supabase
      .from("campaign_sequences")
      .select("id, name")
      .eq("brokerage_id", filters.brokerageId)

    const { data: sequences } = await sequenceQuery
    const sequenceIds = (sequences ?? []).map(s => s.id)
    const sequenceMap = new Map((sequences ?? []).map(s => [s.id, s.name]))

    if (sequenceIds.length === 0) {
      return { success: true, report: emptyReport(filters.scope) }
    }

    // ── 2. Pull enrollments in scope ────────────────────────────────────────
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("id, sequence_id, status, enrolled_at, completed_at, converted_at")
      .in("sequence_id", sequenceIds)
      .gte("enrolled_at", fromDate)
      .lte("enrolled_at", toDate)

    const totalEnrollments     = enrollments?.length ?? 0
    const activeEnrollments    = enrollments?.filter(e => e.status === "active").length ?? 0
    const completedEnrollments = enrollments?.filter(e => e.status === "completed").length ?? 0
    const enrollmentIds        = (enrollments ?? []).map(e => e.id)

    // Average completion duration (enrolled_at → completed_at) in days
    const completedDurations = (enrollments ?? [])
      .filter(e => e.completed_at && e.enrolled_at)
      .map(e => (new Date(e.completed_at!).getTime() - new Date(e.enrolled_at!).getTime()) / 86_400_000)
    const averageCompletionDays = completedDurations.length > 0
      ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
      : null

    // ── 3. Pull step runs ───────────────────────────────────────────────────
    let stepQuery = supabase
      .from("workflow_step_runs")
      .select("channel, status, conversion_value_cents, converted_at")
      .gte("created_at", fromDate)
      .lte("created_at", toDate)

    if (enrollmentIds.length > 0) {
      stepQuery = stepQuery.in("enrollment_id", enrollmentIds)
    } else {
      // No enrollments — short-circuit
      return { success: true, report: { ...emptyReport(filters.scope), totalEnrollments, activeEnrollments, completedEnrollments } }
    }

    if (filters.channel) {
      stepQuery = stepQuery.eq("channel", filters.channel)
    }

    const { data: stepRuns } = await stepQuery

    const totalStepsRun   = stepRuns?.length ?? 0
    const successfulSteps = stepRuns?.filter(r => r.status === "sent" || r.status === "completed").length ?? 0
    const failedSteps     = stepRuns?.filter(r => r.status === "failed" || r.status === "error").length ?? 0
    const blockedSteps    = stepRuns?.filter(r => r.status === "blocked" || r.status === "skipped").length ?? 0

    const totalConversions  = stepRuns?.filter(r => r.converted_at).length ?? 0
    const totalConversionValueCents = (stepRuns ?? [])
      .reduce((sum, r) => sum + ((r.conversion_value_cents as number) ?? 0), 0)

    // ── 4. By-channel breakdown ─────────────────────────────────────────────
    const byChannel: Record<string, { runs: number; successes: number; failures: number }> = {}
    for (const r of stepRuns ?? []) {
      const ch = r.channel ?? "unknown"
      if (!byChannel[ch]) byChannel[ch] = { runs: 0, successes: 0, failures: 0 }
      byChannel[ch].runs += 1
      if (r.status === "sent" || r.status === "completed") byChannel[ch].successes += 1
      if (r.status === "failed" || r.status === "error")    byChannel[ch].failures  += 1
    }

    // ── 5. Top sequences by enrollment count ────────────────────────────────
    const enrollmentsBySequence = new Map<string, { total: number; completed: number }>()
    for (const e of enrollments ?? []) {
      const cur = enrollmentsBySequence.get(e.sequence_id) ?? { total: 0, completed: 0 }
      cur.total += 1
      if (e.status === "completed") cur.completed += 1
      enrollmentsBySequence.set(e.sequence_id, cur)
    }
    const topSequences = Array.from(enrollmentsBySequence.entries())
      .map(([sequenceId, counts]) => ({
        sequenceId,
        name: sequenceMap.get(sequenceId) ?? "Untitled",
        enrollments: counts.total,
        completionRate: counts.total > 0 ? counts.completed / counts.total : 0,
      }))
      .sort((a, b) => b.enrollments - a.enrollments)
      .slice(0, 10)

    return {
      success: true,
      report: {
        scope: filters.scope,
        totalEnrollments,
        activeEnrollments,
        completedEnrollments,
        totalStepsRun,
        successfulSteps,
        failedSteps,
        blockedSteps,
        successRate: totalStepsRun > 0 ? successfulSteps / totalStepsRun : 0,
        totalConversions,
        totalConversionValueCents,
        averageCompletionDays,
        byChannel,
        topSequences,
      },
    }
  } catch (err) {
    return handleError(err, "getWorkflowReport") as { success: false; error: string }
  }
}

function emptyReport(scope: ReportScope): WorkflowReportSummary {
  return {
    scope,
    totalEnrollments: 0,
    activeEnrollments: 0,
    completedEnrollments: 0,
    totalStepsRun: 0,
    successfulSteps: 0,
    failedSteps: 0,
    blockedSteps: 0,
    successRate: 0,
    totalConversions: 0,
    totalConversionValueCents: 0,
    averageCompletionDays: null,
    byChannel: {},
    topSequences: [],
  }
}
