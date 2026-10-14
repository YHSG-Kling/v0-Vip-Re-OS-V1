import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { createClient } from "@/lib/supabase/server"
import { resolveReportScope } from "@/lib/kernel/reporting-scope"
import { getSourcePerformance } from "@/app/actions/source-analytics"
import { SourceAnalyticsClient } from "./source-analytics-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Source Analytics | Dashboard",
  description: "Attribution and ROI reporting by acquisition source",
}

export default async function SourceAnalyticsPage() {
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  // Lane 90A (89D P1-5): the scope is the ONE resolver (lib/kernel/egress-scope.ts
  // through reporting-scope) — broker / owner / admin / compliance → the whole
  // brokerage, a location admin → their location, team_lead → THEIR TEAM ("teams
  // see only their own board", CLAUDE.md §4), everyone else → own work. The
  // `userType === "broker" || "admin" || "superadmin"` literal it replaces gave a
  // broker OWNER the agent view — and that agent view filtered contacts.agent_id
  // (an agents.id) by ctx.userId (a users.id): a query that matched nothing (§3).
  const supabase = await createClient()
  const scope = await resolveReportScope(supabase, {
    userType: ctx.userType,
    userId: ctx.userId,
    agentId: ctx.agentId ?? "",
    brokerageId: ctx.brokerageId,
    teamId: ctx.teamId,
  })
  // null = brokerage-wide; a seat with no agents row narrows to nobody, never to everybody.
  const scopeAgentIds = scope.agentIds ? scope.agentIds.filter(Boolean) : null

  // Initial data load — last 90 days, all source families
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  const initialResult = await getSourcePerformance({
    brokerageId: ctx.brokerageId,
    agentIds: scopeAgentIds,
    dateFrom: ninetyDaysAgo,
    sortBy: "volume",
  })

  return (
    <div className="flex flex-col min-h-full">
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Source Analytics</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Attribution, funnel performance, and ROI by acquisition source
            </p>
          </div>
        </div>
      </div>
      <SourceAnalyticsClient
        brokerageId={ctx.brokerageId}
        scopeAgentIds={scopeAgentIds}
        agentId={scopeAgentIds?.length === 1 ? scopeAgentIds[0] : null}
        initialSources={initialResult.sources}
        initialSummary={initialResult.summary}
      />
    </div>
  )
}
