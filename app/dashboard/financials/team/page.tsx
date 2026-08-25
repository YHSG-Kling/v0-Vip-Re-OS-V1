import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveLedTeamId } from "@/lib/kernel/resolve-user-team"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"
import { DollarSign, Users, TrendingUp, Award, Target, AlertTriangle } from "lucide-react"
import { TeamRevenueChart } from "./team-revenue-chart"
import {
  FinancialCommandStrip,
  FinancialActionStack,
  type FinancialPriority,
  type FinancialAction,
} from "../components/os"
import { loadBrokerageFinancialSummaryAction } from "@/app/actions/financial-kernel"
import { createServiceClient } from "@/lib/supabase/service"
import { ACCOUNTING_OFFERINGS, readScopedAccounting, type ScopedAccountingStatus } from "@/lib/connections/accounting-scopes"
import { defaultQbReconciliationPeriod, loadTeamQbReconciliation, type ScopeQbReconciliation } from "@/lib/finance/qb-reconciliation"
import { ProviderConnectionCard } from "@/app/settings/accounting/provider-connection-card"
import { QbReconciliationCard } from "@/app/settings/accounting/qb-reconciliation-card"

export const dynamic = "force-dynamic"

// Get current period label (e.g., "2026-03")
function getCurrentPeriodLabel() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

export default async function TeamFinancialsPage() {
  const supabase = await createClient()

  // Get agent context
  const { agentId: agentIdRaw, brokerageId: brokerageIdRaw } = await getAgentContext()
  const agentId = agentIdRaw!
  const brokerageId = brokerageIdRaw!

  // Who may see TEAM financials — and it is not a label.
  //
  // Owner ruling: "a team lead is an agent that runs their own team." Leading is
  // a FACT recorded in teams.team_lead_id, and on live data the label is not just
  // a weaker proxy for it, it is UNCORRELATED: teamlead@vip.demo runs a team and
  // carries user_type='agent', while the one account carrying user_type='team_lead'
  // runs no team at all. So the old roster gate bounced the real team lead to
  // /dashboard/financials/agent and would have admitted somebody with no team.
  //
  // m444 fixed exactly this in RLS (public.current_user_led_team_id()). This is
  // the same rule on the same side of the wire: resolveLedTeamId() is that
  // function's app-side twin, so the page and the database cannot disagree about
  // who runs a team.
  //
  // broker / admin keep their seat on the ROLE, because their claim to the team's
  // books is the brokerage's book, not a team they run.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()

  const userRole = profile?.user_type || "agent"
  const isSuperadmin =
    userRole === "superadmin" ||
    (profile as { platform_role?: string | null } | null)?.platform_role === "superadmin"

  // The FACT first: resolved once here and reused as the team id below, so the
  // gate and the data can never be answered differently.
  const ledTeamId = await resolveLedTeamId(supabase, user.id)

  if (!ledTeamId && !isSuperadmin && !["broker", "admin"].includes(userRole)) {
    redirect("/dashboard/financials/agent")
  }

  // ── Team books (scope-aware accounting connection) ─────────────────────────
  // The TEAM's own QuickBooks — owner (owner_type='team', owner_id=team_id),
  // exact match, never the brokerage's connection. Only the team lead's login
  // maps to team scope in the OAuth route, so only they get the connect button.
  // The team id comes from the SAME resolution as the gate above — the lead link
  // — not from users.team_id. That column is one of the four places a team can be
  // recorded on this schema and it is NULL for all 23 live users, so reading it
  // here meant the team's own QuickBooks/Zoom panels silently rendered as "not
  // connected" even for the person who runs the team. m431 made resolve_team_id()
  // the one rule; this page now defers to its lead-link entry point rather than
  // holding a fifth answer.
  const teamId = ledTeamId
  let teamBooks: ScopedAccountingStatus | null = null
  let teamLastSyncedAt: string | null = null
  let teamReconciliation: ScopeQbReconciliation | null = null
  let teamZoom: Awaited<ReturnType<typeof import("@/lib/connections/zoom").readScopedZoom>> | null = null
  if (teamId) {
    const svc = createServiceClient()
    teamBooks = await readScopedAccounting(svc, "team", teamId).catch(() => null)
    // TEAM MEETINGS (round 39) — the team's own Zoom (exact owner match): team
    // members' Zoom appointments host here when they have no personal Zoom.
    const { readScopedZoom } = await import("@/lib/connections/zoom")
    teamZoom = await readScopedZoom(svc, "team", teamId).catch(() => null)
    // QuickBooks reconciliation (round 37) — team P&L rows vs the OS-recorded
    // export markers. Best-effort: a failed read renders nothing.
    teamReconciliation = await loadTeamQbReconciliation(svc, {
      teamId,
      ...defaultQbReconciliationPeriod(),
    }).catch(() => null)
    // Last honest export marker (column arrives with the scoped-accounting-export
    // migration; absent column simply reads null → "Not synced yet").
    const { data: lastExport } = await svc
      .from("team_earnings")
      .select("quickbooks_synced_at")
      .eq("team_id", teamId)
      .not("quickbooks_synced_at", "is", null)
      .order("quickbooks_synced_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    teamLastSyncedAt = ((lastExport as { quickbooks_synced_at?: string | null } | null)?.quickbooks_synced_at) ?? null
  }

  // Load brokerage financial summary via kernel command
  const brokerageFinancialResult = await loadBrokerageFinancialSummaryAction({
    brokerageId,
  })

  if (!brokerageFinancialResult.success) {
    redirect("/dashboard")
  }

  const brokageFinData = brokerageFinancialResult.data as any

  // Extract data from kernel result
  const mtdTotal = brokageFinData?.mtdTotal ?? 0
  const ytdTotal = brokageFinData?.ytdTotal ?? 0
  const ytdTransactions = brokageFinData?.ytdTransactions ?? 0
  const agentCount = brokageFinData?.agentCount ?? 0
  const leaderboard = brokageFinData?.leaderboard ?? { data: [] }
  const teamAgents = brokageFinData?.teamAgents ?? { data: [] }
  const agentEarningsData = brokageFinData?.agentEarningsData ?? { data: [] }
  const recruitingROI = brokageFinData?.recruitingROI ?? []
  const earningsHistory = brokageFinData?.earningsHistory ?? { data: [] }

  // Goals data
  const perf = brokageFinData?.teamPerformance
  const goalPct = perf?.goal_pct || 0
  const goalAmount = perf?.goal_amount || 0
  const currentRevenue = perf?.total_revenue || mtdTotal

  // Goal color
  const goalColor = goalPct < 50 ? "bg-red-500" : goalPct < 80 ? "bg-amber-500" : "bg-green-500"

  // Recruiting ROI totals
  const totalRecruitingCost = recruitingROI.reduce((sum: number, r: any) => sum + (r.total_recruiting_cost || 0), 0)
  const totalRecruitingRevenue = recruitingROI.reduce((sum: number, r: any) => sum + (r.lifetime_brokerage_net || 0), 0)

  // Build financial priority for team lead
  const teamFinancialPriority: FinancialPriority | null = (() => {
    if (goalPct < 50 && goalAmount > 0) {
      return {
        id: "below-goal",
        title: "Team Below Revenue Target",
        description: `Currently at ${goalPct.toFixed(1)}% of ${getCurrentPeriodLabel()} goal`,
        urgency: "high",
        metric: `${goalPct.toFixed(1)}%`,
        metricLabel: "of goal",
        ctaLabel: "View Team Details",
        ctaHref: "/dashboard/team",
      }
    }
    
    if (agentCount < 3) {
      return {
        id: "team-size",
        title: "Consider Team Expansion",
        description: "Growing your team can increase revenue capacity",
        urgency: "low",
        ctaLabel: "Recruiting",
        ctaHref: "/dashboard/recruiting",
      }
    }
    
    return null
  })()

  // Build action stack for team lead
  const teamFinancialActions: FinancialAction[] = [
    {
      id: "review-team-performance",
      title: "Review Agent Performance",
      description: `${agentCount} agents contributing to team revenue`,
      priority: "medium",
      type: "review",
      href: "/dashboard/team",
    },
    {
      id: "view-commissions",
      title: "View Team Commissions",
      description: "Track pending and paid commissions",
      priority: "medium",
      type: "commission",
      value: mtdTotal,
      href: "/dashboard/financials/commissions",
    },
  ]
  
  if (goalPct < 80 && goalAmount > 0) {
    teamFinancialActions.unshift({
      id: "review-goal-progress",
      title: "Address Goal Shortfall",
      description: `${(100 - goalPct).toFixed(1)}% remaining to hit target`,
      priority: goalPct < 50 ? "urgent" : "high",
      type: "budget",
      value: goalAmount - currentRevenue,
    })
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Team Revenue</h1>
          <p className="text-muted-foreground">Financial overview for your team</p>
        </div>
        <Badge variant="outline" className="text-sm">
          {agentCount} Agent{agentCount !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Financial Command Strip */}
      <FinancialCommandStrip
        priority={teamFinancialPriority}
        periodSummary={{
          mtdRevenue: mtdTotal,
          ytdRevenue: ytdTotal,
          pendingCommissions: 0,
          expensesMTD: 0,
        }}
        role="team_lead"
      />

      {/* Section 1: Team KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Team MTD Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${mtdTotal.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">This month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Team YTD Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">${ytdTotal.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Year to date</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Award className="h-4 w-4" />
              Total Transactions YTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{ytdTransactions}</div>
            <p className="text-xs text-muted-foreground">Closed deals</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Agent Count
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{agentCount}</div>
            <p className="text-xs text-muted-foreground">Active agents</p>
          </CardContent>
        </Card>
      </div>

      {/* Section 2: Goals vs Actuals Bar */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Goals vs Actuals
          </CardTitle>
          <CardDescription>
            {getCurrentPeriodLabel()} performance against target
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span>Current: ${currentRevenue.toLocaleString()}</span>
            <span>Goal: ${goalAmount.toLocaleString()}</span>
          </div>
          <Progress value={Math.min(goalPct, 100)} className={goalColor} />
          <div className="flex items-center justify-between">
            <span className={`text-sm font-medium ${goalPct < 50 ? "text-red-600" : goalPct < 80 ? "text-amber-600" : "text-green-600"}`}>
              {goalPct.toFixed(1)}% of goal
            </span>
            {goalPct < 50 && (
              <span className="text-xs text-red-600 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Below target
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Section 3: Top 5 Leaderboard Widget */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Award className="h-5 w-5" />
            Top 5 Leaderboard
          </CardTitle>
          <CardDescription>
            Revenue leaders for {getCurrentPeriodLabel()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {leaderboard.data && leaderboard.data.length > 0 ? (
            <div className="space-y-3">
              {leaderboard.data.map((entry: any, idx: number) => {
                const agentName = entry.agents?.users
                  ? `${entry.agents.users.first_name || ""} ${entry.agents.users.last_name || ""}`.trim()
                  : "Unknown Agent"
                const isCurrentUser = entry.agent_id === agentId

                return (
                  <div
                    key={entry.id}
                    className={`flex items-center justify-between p-3 rounded-lg ${isCurrentUser ? "bg-blue-50 border border-blue-200" : "bg-muted/50"}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                        idx === 0 ? "bg-yellow-400 text-yellow-900" :
                        idx === 1 ? "bg-gray-300 text-gray-700" :
                        idx === 2 ? "bg-amber-600 text-white" :
                        "bg-muted text-muted-foreground"
                      }`}>
                        {entry.rank_position}
                      </span>
                      <span className="font-medium">{agentName}</span>
                      {isCurrentUser && <Badge variant="outline" className="text-xs">You</Badge>}
                    </div>
                    <span className="font-semibold">${(entry.metric_value || 0).toLocaleString()}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">No leaderboard data for this period</p>
          )}
          <div className="mt-4 text-center">
            <Link href="/dashboard/motivation" className="text-blue-600 hover:underline text-sm">
              View Full Leaderboard
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Section 4: Per-Agent Breakdown Table */}
      <Card>
        <CardHeader>
          <CardTitle>Per-Agent Breakdown</CardTitle>
          <CardDescription>
            Individual agent performance within the team
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-3 px-2 font-medium">Agent Name</th>
                  <th className="text-right py-3 px-2 font-medium">MTD Net</th>
                  <th className="text-right py-3 px-2 font-medium">YTD Net</th>
                  <th className="text-right py-3 px-2 font-medium">Transactions YTD</th>
                  <th className="text-center py-3 px-2 font-medium">Cap Status</th>
                  <th className="text-right py-3 px-2 font-medium">Points</th>
                </tr>
              </thead>
              <tbody>
                {teamAgents.data?.map((agent: any) => {
                  const agentName = agent.users
                    ? `${agent.users.first_name || ""} ${agent.users.last_name || ""}`.trim()
                    : "Unknown"

                  // Find MTD and YTD earnings for this agent
                  const agentMTD = agentEarningsData.data?.find(
                    (e: any) => e.agent_id === agent.id && e.period_type === "mtd"
                  )
                  const agentYTD = agentEarningsData.data?.find(
                    (e: any) => e.agent_id === agent.id && e.period_type === "ytd"
                  )

                  const mtdNet = agentMTD?.agent_net || 0
                  const ytdNet = agentYTD?.agent_net || 0
                  const ytdTxns = agentYTD?.transaction_count || 0
                  const capStatus = agentYTD?.cap_status || "active"

                  return (
                    <tr key={agent.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 px-2">
                        {userRole === "broker" || userRole === "admin" ? (
                          <Link
                            href={`/dashboard/financials/agent?agentId=${agent.id}`}
                            className="text-blue-600 hover:underline"
                          >
                            {agentName}
                          </Link>
                        ) : (
                          agentName
                        )}
                      </td>
                      <td className="py-3 px-2 text-right">${mtdNet.toLocaleString()}</td>
                      <td className="py-3 px-2 text-right">${ytdNet.toLocaleString()}</td>
                      <td className="py-3 px-2 text-right">{ytdTxns}</td>
                      <td className="py-3 px-2 text-center">
                        <Badge variant={capStatus === "capped" ? "default" : "outline"}>
                          {capStatus}
                        </Badge>
                      </td>
                      <td className="py-3 px-2 text-right">{agent.gamification_points || 0}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(!teamAgents.data || teamAgents.data.length === 0) && (
            <p className="text-muted-foreground text-center py-4">No agents found in team</p>
          )}
        </CardContent>
      </Card>

      {/* Section 5: Team Recruiting ROI Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Recruiting ROI Summary</CardTitle>
          <CardDescription>
            Cost to recruit vs revenue generated
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Total Recruiting Cost</p>
              <p className="text-xl font-bold">${totalRecruitingCost.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Revenue Generated</p>
              <p className="text-xl font-bold text-green-600">${totalRecruitingRevenue.toLocaleString()}</p>
            </div>
          </div>
          <div className="mt-4 text-center">
            <Link href="/dashboard/recruiting-roi" className="text-blue-600 hover:underline text-sm">
              View Full ROI Analysis
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Section 6: Team Revenue 12-Month Trend */}
      <Card>
        <CardHeader>
          <CardTitle>Team Revenue Trend</CardTitle>
          <CardDescription>
            Last 6 months revenue by agent
          </CardDescription>
        </CardHeader>
        <CardContent className="h-80">
          <TeamRevenueChart
            earningsHistory={earningsHistory.data || []}
            teamAgents={teamAgents.data || []}
          />
        </CardContent>
      </Card>

      {/* Section 7: Team Books — the TEAM's own accounting connections (scope-aware) */}
      {teamId && teamBooks && (
        <div className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold">Team Books</h2>
            <p className="text-sm text-muted-foreground">
              The team&apos;s own accounting — separate from the brokerage&apos;s books. Team P&amp;L rows
              export to the team&apos;s QuickBooks and show &quot;Not synced&quot; until a real export happens.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <ProviderConnectionCard
              provider="quickbooks"
              scope="team"
              status={teamBooks.quickbooks.offering.status}
              connected={teamBooks.quickbooks.connected}
              companyName={teamBooks.quickbooks.accountName ?? teamBooks.quickbooks.realmId}
              lastSyncedAt={teamLastSyncedAt}
              connectPath={teamBooks.quickbooks.offering.connectPath}
              note={teamBooks.quickbooks.offering.verdict}
              canConnect={Boolean(ledTeamId)}
              connectDisabledReason="Only the team lead's login connects the team's QuickBooks — the connection is owned by the team, and 'team lead' is resolved from teams.team_lead_id, not from a role label."
            />
            <ProviderConnectionCard
              provider="stripe"
              scope="team"
              status={ACCOUNTING_OFFERINGS.team.stripe.status}
              connected={false}
              note={ACCOUNTING_OFFERINGS.team.stripe.verdict}
            />
            {/* MEETINGS (round 39) — the team's Zoom, same card idiom + provider gating. */}
            {teamZoom && (
              <ProviderConnectionCard
                provider="zoom"
                scope="team"
                status={teamZoom.offering.status}
                connected={teamZoom.connected}
                companyName={teamZoom.accountEmail}
                connectPath={teamZoom.offering.connectPath}
                note={teamZoom.offering.verdict}
                canConnect={userRole === "team_lead" && teamZoom.providerGap === null}
                connectDisabledReason={
                  teamZoom.providerGap ??
                  "Only the team lead's login connects the team's Zoom (the connection is owned by the team, resolved from the team lead's role)."
                }
              />
            )}
          </div>
          {/* QuickBooks reconciliation (round 37) — team P&L vs OS-recorded exports. */}
          {teamReconciliation && <QbReconciliationCard recon={teamReconciliation} />}
        </div>
      )}

      {/* Section 8: Financial Action Stack */}
      <FinancialActionStack actions={teamFinancialActions} />
    </div>
  )
}
