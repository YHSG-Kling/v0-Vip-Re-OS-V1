"use server"

/**
 * Workflow OS reporting actions.
 *
 * Reads sequence_step_executions + sequence_enrollments + campaign_sequences and
 * surfaces aggregate metrics scoped to:
 *   - brokerage  (broker / admin role view)
 *   - team       (team-lead view, filtered by team_id)
 *   - agent      (single-agent view)
 *
 * SCOPE WAS A LABEL (lane 83E). teamId and agentId were accepted and never read,
 * so "My deals" and "My team" rendered the whole brokerage's numbers to anyone who
 * could open the page, and brokerageId was taken from the caller. Now:
 *   · the tenant comes from the SESSION (CLAUDE.md §4); a brokerageId naming any
 *     other tenant is refused unless the caller is platform staff;
 *   · brokerage scope needs a tenant admin (user_type or grant) or platform staff;
 *     team scope needs that admin or the team's lead (teams.team_lead_id); agent
 *     scope is the caller's own agents row unless an admin names another agent;
 *   · agent/team numbers are CREDITED TO THE CURRENT HOLDER of each enrolled
 *     contact (lib/campaign-sequences/enrollment-attribution.ts), not the enroller.
 *     enrolled_by stays as history: `inheritedEnrollments` counts the in-scope
 *     enrollments someone else started. Lead enrollments (no contact) belong to the
 *     brokerage (§5) and count in the brokerage view only.
 * Every read is on the caller's RLS client.
 */

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"
import { isPlatformStaffIdentity, resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { creditEnrollment, loadContactHolders } from "@/lib/campaign-sequences/enrollment-attribution"

export type ReportScope = "brokerage" | "team" | "agent"

export interface WorkflowReportFilters {
  scope:        ReportScope
  /** Platform staff may name a tenant; for everyone else it must be their own (session) tenant. */
  brokerageId?: string
  /** scope === "team": a tenant admin may name any team of the tenant; a team lead gets the team they lead. */
  teamId?:      string
  /** scope === "agent": agents.id (NOT users.id). Honoured for a tenant admin; everyone else gets their own. */
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
  /** In-scope enrollments started by someone other than the contact's current holder (enrolled_by kept as history). */
  inheritedEnrollments: number
  activeEnrollments:    number
  completedEnrollments: number
  totalStepsRun:        number
  successfulSteps:      number
  failedSteps:          number
  blockedSteps:         number
  successRate:          number      // 0..1
  totalConversions:     number
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

    // ── 0. Who is asking, for which tenant, over which holders ──────────────
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Sign in to view workflow reports." }
    const { data: me, error: meError } = await supabase
      .from("users").select("brokerage_id, team_id, user_type, platform_role").eq("id", user.id).maybeSingle()
    if (meError) return { success: false, error: `Workflow report refused: your profile could not be read (${meError.message}).` }
    const isStaff = isPlatformStaffIdentity(me?.user_type, me?.platform_role)
    const brokerageId = isStaff ? (filters.brokerageId ?? me?.brokerage_id ?? null) : (me?.brokerage_id ?? null)
    if (!brokerageId) return { success: false, error: "Workflow report refused: your account carries no brokerage." }
    if (!isStaff && filters.brokerageId && filters.brokerageId !== brokerageId) {
      return { success: false, error: "Workflow report refused: that brokerage is not yours." }
    }
    const admin = isStaff
      ? { ok: true as const, isTenantAdmin: true }
      : await resolveTenantAdmin(supabase, user.id, { user_type: me?.user_type, brokerage_id: brokerageId })
    if (!admin.ok) return { success: false, error: `Workflow report refused: role grants could not be read (${admin.error}).` }

    // "Teams see only their own board" (CLAUDE.md §4): team_lead sits in the tenant
    // roster, but its board is the team it leads (teams.team_lead_id), never the brokerage.
    const brokerageAdmin = admin.isTenantAdmin && me?.user_type !== "team_lead"

    // null = brokerage view (every enrollment); otherwise the agents.id set whose
    // CURRENT contacts are in scope.
    let scopeAgentIds: Set<string> | null = null
    if (filters.scope === "brokerage") {
      if (!brokerageAdmin) return { success: false, error: "The brokerage workflow report is for tenant admins." }
    } else if (filters.scope === "team") {
      const requestedTeamId = filters.teamId ?? me?.team_id ?? null
      if (brokerageAdmin && !requestedTeamId) return { success: false, error: "Pick a team to report on." }
      let teamQuery = supabase.from("teams").select("id").eq("brokerage_id", brokerageId)
      teamQuery = brokerageAdmin && requestedTeamId
        ? teamQuery.eq("id", requestedTeamId)
        : teamQuery.eq("team_lead_id", user.id)
      const { data: teams, error: teamError } = await teamQuery
      if (teamError) return { success: false, error: `Workflow report refused: teams could not be read (${teamError.message}).` }
      const teamIds = (teams ?? []).map((t) => t.id as string).filter((id) => !filters.teamId || id === filters.teamId)
      if (teamIds.length === 0) return { success: false, error: "The team workflow report is for that team's lead or a tenant admin." }
      const { data: members, error: memberError } = await supabase
        .from("agents").select("id").eq("brokerage_id", brokerageId).in("team_id", teamIds)
      if (memberError) return { success: false, error: `Workflow report refused: team agents could not be read (${memberError.message}).` }
      scopeAgentIds = new Set((members ?? []).map((a) => a.id as string))
    } else {
      const ownAgentId = await resolveAgentIdInBrokerage(supabase, user.id, brokerageId)
      const agentId = brokerageAdmin && filters.agentId ? filters.agentId : ownAgentId
      if (!agentId) return { success: false, error: "No agent profile in this brokerage to report on." }
      scopeAgentIds = new Set([agentId])
    }

    const fromDate = filters.fromDate ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const toDate   = filters.toDate   ?? new Date().toISOString()

    // ── 1. Resolve which sequence ids fall in scope ─────────────────────────
    // campaign_sequences carries no agent_id/team_id — ownership is created_by +
    // brokerage_id. Team/agent scope is applied downstream at the enrollment level,
    // credited to the contact's CURRENT holder (step 2).
    const sequenceQuery = supabase
      .from("campaign_sequences")
      .select("id, name")
      .eq("brokerage_id", brokerageId)

    const { data: sequences, error: sequencesError } = await sequenceQuery
    if (sequencesError) return { success: false, error: `Workflow report refused: sequences could not be read (${sequencesError.message}).` }
    const sequenceIds = (sequences ?? []).map(s => s.id)
    const sequenceMap = new Map((sequences ?? []).map(s => [s.id, s.name]))

    if (sequenceIds.length === 0) {
      return { success: true, report: emptyReport(filters.scope) }
    }

    // ── 2. Pull enrollments in scope ────────────────────────────────────────
    const { data: enrollmentRows, error: enrollmentsError } = await supabase
      .from("sequence_enrollments")
      .select("id, sequence_id, status, enrolled_at, completed_at, converted_at, contact_id, enrolled_by")
      .in("sequence_id", sequenceIds)
      .gte("enrolled_at", fromDate)
      .lte("enrolled_at", toDate)
    if (enrollmentsError) return { success: false, error: `Workflow report refused: enrollments could not be read (${enrollmentsError.message}).` }

    // CREDIT FOLLOWS THE CONTACT — the current holder, never the enroller.
    const held = await loadContactHolders(
      supabase,
      brokerageId,
      (enrollmentRows ?? []).map((e) => e.contact_id as string | null).filter((c): c is string => !!c),
    )
    if (!held.ok) return { success: false, error: `Workflow report refused: ${held.error}` }
    let inheritedEnrollments = 0
    const enrollments = (enrollmentRows ?? []).filter((e) => {
      const credit = creditEnrollment(e, e.contact_id ? held.holders.get(e.contact_id) : undefined)
      const inScope = scopeAgentIds === null || (!!credit.creditedAgentId && scopeAgentIds.has(credit.creditedAgentId))
      if (inScope && credit.inherited) inheritedEnrollments += 1
      return inScope
    })

    const totalEnrollments     = enrollments?.length ?? 0
    const activeEnrollments    = enrollments?.filter(e => e.status === "active").length ?? 0
    const completedEnrollments = enrollments?.filter(e => e.status === "completed").length ?? 0
    const enrollmentIds        = (enrollments ?? []).map(e => e.id)

    // Average completion duration (enrolled_at → completed_at) in days — COMPLETED
    // enrollments only. completed_at is also stamped by lib/campaign-sequences/
    // enrollment-engine.ts unenrollContact (status 'unenrolled'), so filtering on the
    // timestamp alone averaged "how long until someone pulled them out" into "how long a
    // sequence takes to finish" (wave 84E).
    const completedDurations = (enrollments ?? [])
      .filter(e => e.status === "completed" && e.completed_at && e.enrolled_at)
      .map(e => (new Date(e.completed_at!).getTime() - new Date(e.enrolled_at!).getTime()) / 86_400_000)
    const averageCompletionDays = completedDurations.length > 0
      ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
      : null

    // ── 3. Pull step runs ───────────────────────────────────────────────────
    // ONE LEDGER (m302). This read workflow_step_runs, a duplicate of
    // sequence_step_executions written from the adjacent line of
    // step-executor.ts — best-effort, and inserted only AFTER the compliance
    // gate, so authority-blocked and channel-restricted steps never appeared in
    // it. "Blocked steps" therefore counted over-touch deferrals and nothing
    // else: the compliance gate could be stopping every send and this report
    // would show zero blocks. Reading the canonical ledger fixes that count as
    // a side effect of removing the duplicate.
    let stepQuery = supabase
      .from("sequence_step_executions")
      .select("channel, status")
      .gte("created_at", fromDate)
      .lte("created_at", toDate)

    if (enrollmentIds.length > 0) {
      stepQuery = stepQuery.in("enrollment_id", enrollmentIds)
    } else {
      // No enrollments — short-circuit
      return { success: true, report: { ...emptyReport(filters.scope), totalEnrollments, inheritedEnrollments, activeEnrollments, completedEnrollments } }
    }

    if (filters.channel) {
      stepQuery = stepQuery.eq("channel", filters.channel)
    }

    // supabase-js RESOLVES a refusal (§3): an unread error rendered every step tile as a
    // confident zero. Refuse the report instead of reporting "nothing ran".
    const { data: stepRuns, error: stepRunsError } = await stepQuery
    if (stepRunsError) return { success: false, error: `Workflow report refused: step executions could not be read (${stepRunsError.message}).` }

    // Status sets are the ones sequence_step_executions actually admits
    // (authority_blocked | clicked | delivered | failed | opened | pending |
    // replied | sent | skipped). The old sets were written against
    // workflow_step_runs' vocabulary and carried three words this column cannot
    // hold — 'completed', 'error' and 'blocked' — which would each have counted
    // exactly nothing here. Blocked now includes authority_blocked, which is the
    // compliance gate finally appearing in the report at all.
    const totalStepsRun   = stepRuns?.length ?? 0
    const DELIVERED = new Set(["sent", "delivered", "opened", "clicked", "replied"])
    const successfulSteps = stepRuns?.filter(r => DELIVERED.has(r.status as string)).length ?? 0
    const failedSteps     = stepRuns?.filter(r => r.status === "failed").length ?? 0
    const blockedSteps    = stepRuns?.filter(r => r.status === "skipped" || r.status === "authority_blocked").length ?? 0

    // CONVERSIONS COME FROM THE ENROLLMENT, NOT THE STEP. They used to be read
    // from workflow_step_runs.converted_at / conversion_value_cents — columns
    // that never had a writer, so both tiles rendered a permanent zero for every
    // brokerage. The enrollment is where a conversion is actually recorded
    // (lib/campaign-sequences/sequence-conversion.ts stamps it when the enrolled
    // contact's transaction closes, off the same cron as marketing attribution).
    //
    // Conversion VALUE is deliberately not reported here. Splitting deal dollars
    // across the things that touched a contact is what lib/marketing/
    // attribution.ts does, across four models, and inventing a second answer on
    // this page is how the dead columns got there in the first place.
    const totalConversions = enrollments?.filter(e => e.converted_at).length ?? 0

    // ── 4. By-channel breakdown ─────────────────────────────────────────────
    const byChannel: Record<string, { runs: number; successes: number; failures: number }> = {}
    for (const r of stepRuns ?? []) {
      const ch = r.channel ?? "unknown"
      if (!byChannel[ch]) byChannel[ch] = { runs: 0, successes: 0, failures: 0 }
      byChannel[ch].runs += 1
      // ONE VOCABULARY (§6, wave 84E): the per-channel split counts with the SAME sets as
      // the totals above. It tested 'completed' and 'error' — words the
      // sequence_step_executions status CHECK cannot hold (scripts/check-vocabularies.ts),
      // so opened/clicked/replied/delivered sends were never a channel "success" and the
      // channel tiles disagreed with successfulSteps.
      if (DELIVERED.has(r.status as string)) byChannel[ch].successes += 1
      if (r.status === "failed")             byChannel[ch].failures  += 1
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
        inheritedEnrollments,
        activeEnrollments,
        completedEnrollments,
        totalStepsRun,
        successfulSteps,
        failedSteps,
        blockedSteps,
        successRate: totalStepsRun > 0 ? successfulSteps / totalStepsRun : 0,
        totalConversions,
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
    inheritedEnrollments: 0,
    activeEnrollments: 0,
    completedEnrollments: 0,
    totalStepsRun: 0,
    successfulSteps: 0,
    failedSteps: 0,
    blockedSteps: 0,
    successRate: 0,
    totalConversions: 0,
    averageCompletionDays: null,
    byChannel: {},
    topSequences: [],
  }
}
