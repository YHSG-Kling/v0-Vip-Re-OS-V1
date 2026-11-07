/**
 * /dashboard/campaigns/workflow-reports
 *
 * Workflow OS reporting dashboard. Surfaces aggregate metrics from
 * sequence_step_executions + sequence_enrollments scoped to:
 *   - agent      (single-agent view, default for agent role)
 *   - team       (team-lead role)
 *   - brokerage  (broker / admin role)
 *
 * Server component — runs getWorkflowReport on the server, hands data to
 * the client view for filter changes.
 */

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getWorkflowReport, type ReportScope } from "@/app/actions/workflow-reports"
import WorkflowReportsClient from "./workflow-reports-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { resolveEgressScopeForViewer } from "@/lib/kernel/egress-scope"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ scope?: string; from?: string; to?: string; channel?: string }>
}

export default async function WorkflowReportsPage({ searchParams }: PageProps) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login?redirect=/dashboard/campaigns/workflow-reports")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Resolve scope context from user's role
  const { data: userRow } = await supabase
    .from("users").select("brokerage_id, team_id, user_type, platform_role").eq("id", user.id).maybeSingle()
  if (!userRow?.brokerage_id) redirect("/login")

  const role = userRow.user_type ?? userRow.platform_role ?? "agent"
  const requestedScope = (params.scope as ReportScope | undefined)
    ?? await defaultScopeForSeat({ ...userRow, brokerage_id: userRow.brokerage_id }, user.id)

  // Resolve agent.id (offers/sequences ref agents.id, not user_id) for agent-scoped reports
  let agentId: string | undefined
  if (requestedScope === "agent") {
    const { data: agentRow } = await supabase
      .from("agents").select("id").eq("user_id", user.id).maybeSingle()
    agentId = agentRow?.id
  }

  // Default range: last 30 days
  const fromDate = params.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
  const toDate   = params.to   ?? new Date().toISOString()

  const { success, report, error } = await getWorkflowReport({
    scope:       requestedScope,
    brokerageId: userRow.brokerage_id,
    teamId:      requestedScope === "team" ? userRow.team_id ?? undefined : undefined,
    agentId,
    fromDate,
    toDate,
    channel:     params.channel,
  })

  return (
    <WorkflowReportsClient
      role={role}
      brokerageId={userRow.brokerage_id}
      teamId={userRow.team_id}
      currentScope={requestedScope}
      report={success && report ? report : null}
      error={success ? null : (error ?? "Could not load report")}
      filters={{ fromDate, toDate, channel: params.channel ?? "" }}
    />
  )
}

/**
 * Lane 90A (89D P1-5): the default scope is the ONE resolver's answer
 * (lib/kernel/egress-scope.ts) — brokerage-wide seats and a location admin
 * open on the brokerage report, a team lead on THEIR TEAM ("teams see only
 * their own board"), everyone else on their own. Platform staff (both identity
 * columns, isPlatformStaffIdentity) open on the brokerage. The
 * `role === "broker" || "admin" || "platform_admin"` literal it replaces sent a
 * broker OWNER / broker admin / compliance officer to the agent report by
 * default — the action (getWorkflowReport) would have admitted them to the
 * brokerage report all along.
 */
// Wave 150 (lane 150DAC, C34): on a MULTI-LOCATION tenant the default comes from the hierarchy
// (resolveEgressScopeForViewer — a broker without a leadership grant opens on their own work, never the whole house
// because of a user_type); a single-office tenant keeps the ladder. Session ids only (the page's own user row).
async function defaultScopeForSeat(seat: { user_type: string | null; platform_role: string | null; team_id: string | null; brokerage_id: string }, userId: string): Promise<ReportScope> {
  if (isPlatformStaffIdentity(seat.user_type, seat.platform_role)) return "brokerage"
  const { scope } = await resolveEgressScopeForViewer(createServiceClient(), {
    userType: seat.user_type ?? "agent",
    userId,
    brokerageId: seat.brokerage_id,
    teamId: seat.team_id,
  })
  const kind = scope.kind
  if (kind === "team") return "team"
  if (kind === "agent") return "agent"
  return "brokerage"
}
