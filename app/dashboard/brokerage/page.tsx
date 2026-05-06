import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getBrokerageDashboard, forecastBrokerageRevenue, trackLicenseExpirations } from "@/app/actions/multi-persona"
import { getRecruitingROISummary, getRecruitingCostBreakdown, getBreakEvenAnalysis } from "@/app/actions/recruiting-roi"
import { getHighFatigueBuyers, getBrokerageFatigueAlerts } from "@/app/actions/buyer-fatigue"
import { getSystemProviderStatus } from "@/app/actions/settings/provider-settings-actions"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import {
  Building2,
  Users,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  Shield,
  FileText,
  Activity,
  Brain,
  ArrowRight,
  BarChart3,
} from "lucide-react"
import { BrokerageAgentList } from "@/app/components/features/dashboard/brokerage/agent-list"
import { TodaysFocusCard } from "@/app/components/shell/todays-focus-card"
import { generateUserTypeBrief } from "@/lib/intelligence/user-type-briefs"
import { BrokerageRevenueChart } from "@/app/components/features/dashboard/brokerage/revenue-chart"
import { BrokerageComplianceOverview } from "@/app/components/features/dashboard/brokerage/compliance-overview"
import {
  BrokerCommandStrip,
  BrokerRiskRadar,
  BrokerFinancialPulse,
  BrokerDealHealthPanel,
  BrokerTeamPerformancePanel,
  BrokerFatiguePanel,
  BrokerRecruitingROIPanel,
  BrokerBreakEvenCard,
  BrokerProviderPressurePanel,
  BrokerActionStack,
  type BrokerPriority,
  type BrokerAction,
} from "./components/command-center"
import { BrokerRecruitingActionBar } from "./components/broker-recruiting-action-bar"
import { BrokerProviderHealthActions } from "./components/broker-provider-health-actions"
import { BrokerTeamAssignmentBar } from "./components/broker-team-assignment-bar"

export default async function BrokerageDashboard({
  searchParams,
}: {
  searchParams: Promise<{ brokerageId?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  let brokerageId = params.brokerageId
  if (!brokerageId) {
    // Look up via users.brokerage_id — brokerages table has no owner_id column
    const { data: userRow } = await supabase
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle()
    // Guard: only broker/admin/superadmin may access this dashboard
    if (!userRow?.brokerage_id || !["broker", "admin", "superadmin"].includes(userRow.user_type ?? "")) {
      redirect("/dashboard")
    }
    brokerageId = userRow.brokerage_id
  }

  if (!brokerageId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No brokerage found. Please contact support.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Fetch all data in parallel
  const [
    dashboard,
    forecastData,
    expirations,
    recruitingROI,
    costBreakdown,
    breakEvenAnalysis,
    fatigueResult,
    fatigueAlertsResult,
    dealHealthResult,
    transactionsResult,
    providerStatusResult,
    unassignedLeadsResult,
    pendingDistributionsResult,
  ] = await Promise.all([
    getBrokerageDashboard(brokerageId),
    forecastBrokerageRevenue(brokerageId, 3),
    trackLicenseExpirations(brokerageId),
    getRecruitingROISummary(brokerageId).catch(() => ({
      totalInvested: 0,
      totalGenerated: 0,
      avgROI: 0,
      activeRecruits: 0,
      profitableRecruits: 0,
    })),
    getRecruitingCostBreakdown(brokerageId).catch(() => ({
      training: 0,
      marketing: 0,
      technology: 0,
      bonuses: 0,
      guarantees: 0,
      other: 0,
    })),
    getBreakEvenAnalysis(brokerageId).catch(() => ({
      avgBreakEvenMonth: 0,
      breakEvenMonths: [],
    })),
    getHighFatigueBuyers(brokerageId).catch(() => ({ success: false, buyers: [] })),
    getBrokerageFatigueAlerts(brokerageId).catch(() => ({ success: false, alerts: [] })),
    // Fetch deal health scores - separate queries to avoid ambiguous relationship
    supabase
      .from("deal_health_scores")
      .select(`
        id,
        transaction_id,
        overall_score,
        risk_level,
        ai_narrative
      `)
      .eq("brokerage_id", brokerageId)
      .in("risk_level", ["critical", "at_risk", "watch"])
      .order("overall_score", { ascending: true })
      .limit(10),
    // Then fetch transactions separately
    supabase
      .from("transactions")
      .select("id, property_address, close_date, agent_id, contact_id")
      .eq("brokerage_id", brokerageId)
      .in("stage", ["active", "pending", "contingent"]),
    // Provider health status
    getSystemProviderStatus().catch(() => ({ directMailEnabled: true, videoEnabled: true })),
    // Unassigned leads count
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .is("assigned_agent_id", null)
      .eq("is_active", true),
    // Pending brokerage commission distributions
    supabase
      .from("commission_distributions")
      .select("id, calculated_amount, status, created_at, transaction_id")
      .eq("brokerage_id", brokerageId)
      .eq("distribution_type", "brokerage")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(20),
  ])

  const agents = (dashboard as any).agents ?? []
  const activeTransactionsRaw = (dashboard as any).activeTransactions ?? []
  const activeTransactions: number = Array.isArray(activeTransactionsRaw) ? activeTransactionsRaw.length : (Number(activeTransactionsRaw) || 0)
  const complianceRate: number = (dashboard as any).complianceRate ?? 0
  const totalGCI: number = (dashboard as any).totalGCI ?? 0
  const pendingCommissions: number = (dashboard as any).pendingCommissions ?? 0

  const pendingDistributions = pendingDistributionsResult.data ?? []
  const totalPendingBrokerageCommission = pendingDistributions.reduce(
    (sum: number, d: { calculated_amount: number | null }) => sum + (d.calculated_amount ?? 0),
    0,
  )
  const now = new Date()
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const expectedThisMonth = pendingDistributions.filter((d: { created_at: string }) => {
    return new Date(d.created_at) >= thisMonthStart
  }).reduce((sum: number, d: { calculated_amount: number | null }) => sum + (d.calculated_amount ?? 0), 0)

  // Process fatigue data
  const fatigueBuyers = (fatigueResult.success ? (fatigueResult as any).buyers : []) || []
  const fatigueAlerts = (fatigueAlertsResult.success ? (fatigueAlertsResult as any).alerts : []) || []
  const fatigueSummary = {
    critical: fatigueBuyers.filter((b: any) => b.fatigue_score >= 80).length,
    warning: fatigueBuyers.filter((b: any) => b.fatigue_score >= 60 && b.fatigue_score < 80).length,
    watch: fatigueBuyers.filter((b: any) => b.fatigue_score >= 35 && b.fatigue_score < 60).length,
  }

  // Process deal health data
  const dealHealthScores = dealHealthResult.data || []
  const dealHealthSummary = {
    critical: dealHealthScores.filter((d: any) => d.risk_level === "critical").length,
    at_risk: dealHealthScores.filter((d: any) => d.risk_level === "at_risk").length,
    watch: dealHealthScores.filter((d: any) => d.risk_level === "watch").length,
    healthy: activeTransactions - dealHealthScores.length,
    total: activeTransactions,
  }

  // Build broker priority (most urgent issue)
  const brokerPriority: BrokerPriority | null = (() => {
    // Critical deals take highest priority
    if (dealHealthSummary.critical > 0) {
      return {
        id: "critical-deals",
        title: `${dealHealthSummary.critical} Deal${dealHealthSummary.critical !== 1 ? "s" : ""} at Critical Risk`,
        description: "These transactions may miss closing without intervention",
        urgency: "critical",
        metric: String(dealHealthSummary.critical),
        metricLabel: "critical",
        ctaLabel: "Review Deal Health",
        ctaHref: "/dashboard/brokerage/deal-health",
      }
    }

    // High fatigue
    if (fatigueSummary.critical > 0) {
      return {
        id: "fatigue-critical",
        title: `${fatigueSummary.critical} Buyer${fatigueSummary.critical !== 1 ? "s" : ""} at Critical Fatigue`,
        description: "These buyers may disengage without support",
        urgency: "high",
        metric: String(fatigueSummary.critical),
        metricLabel: "critical",
        ctaLabel: "Open Fatigue View",
        ctaHref: "/dashboard/brokerage/fatigue",
      }
    }

    // At-risk deals
    if (dealHealthSummary.at_risk > 2) {
      return {
        id: "at-risk-deals",
        title: `${dealHealthSummary.at_risk} Deals Need Attention`,
        description: "Multiple transactions showing risk signals",
        urgency: "medium",
        metric: String(dealHealthSummary.at_risk),
        metricLabel: "at risk",
        ctaLabel: "Review Deal Health",
        ctaHref: "/dashboard/brokerage/deal-health",
      }
    }

    // Break-even concern
    if (breakEvenAnalysis.avgBreakEvenMonth > 18) {
      return {
        id: "break-even-long",
        title: "Recruiting Break-Even is Lengthening",
        description: "New recruits are taking longer to become profitable",
        urgency: "medium",
        metric: `${breakEvenAnalysis.avgBreakEvenMonth.toFixed(1)}mo`,
        metricLabel: "avg break-even",
        ctaLabel: "Review Recruiting ROI",
        ctaHref: "/dashboard/recruiting-roi",
      }
    }

    return null
  })()

  // Build risk signals
  const riskSignals = [
    {
      category: "deals" as const,
      level: dealHealthSummary.critical > 0 ? "critical" as const :
             dealHealthSummary.at_risk > 2 ? "warning" as const :
             dealHealthSummary.at_risk > 0 ? "watch" as const : "healthy" as const,
      label: "Deal Health",
      value: dealHealthSummary.critical + dealHealthSummary.at_risk,
      description: dealHealthSummary.critical > 0 ? `${dealHealthSummary.critical} critical` : undefined,
    },
    {
      category: "fatigue" as const,
      level: fatigueSummary.critical > 0 ? "critical" as const :
             fatigueSummary.warning > 2 ? "warning" as const :
             fatigueSummary.watch > 0 ? "watch" as const : "healthy" as const,
      label: "Buyer Fatigue",
      value: fatigueSummary.critical + fatigueSummary.warning,
      description: fatigueSummary.critical > 0 ? `${fatigueSummary.critical} critical` : undefined,
    },
    {
      category: "compliance" as const,
      level: complianceRate < 80 ? "warning" as const :
             complianceRate < 95 ? "watch" as const : "healthy" as const,
      label: "Compliance",
      value: Math.round(complianceRate || 0),
      description: complianceRate < 80 ? "Below threshold" : undefined,
    },
    {
      category: "payouts" as const,
      level: (pendingCommissions || 0) > 100000 ? "warning" as const :
             (pendingCommissions || 0) > 50000 ? "watch" as const : "healthy" as const,
      label: "Pending Payouts",
      value: Math.round((pendingCommissions || 0) / 1000),
      description: pendingCommissions > 50000 ? `$${Math.round(pendingCommissions / 1000)}K pending` : undefined,
    },
  ]

  // Build action stack
  const brokerActions: BrokerAction[] = []

  if (dealHealthSummary.critical > 0) {
    brokerActions.push({
      id: "review-critical-deals",
      title: "Review Critical Deals",
      description: `${dealHealthSummary.critical} transaction${dealHealthSummary.critical !== 1 ? "s" : ""} at critical risk`,
      priority: "urgent",
      type: "deal",
      href: "/dashboard/brokerage/deal-health",
    })
  }

  if (fatigueSummary.critical > 0 || fatigueSummary.warning > 2) {
    brokerActions.push({
      id: "review-fatigue",
      title: "Address Fatigue Alerts",
      description: `${fatigueSummary.critical + fatigueSummary.warning} buyers showing fatigue`,
      priority: fatigueSummary.critical > 0 ? "high" : "medium",
      type: "people",
      href: "/dashboard/brokerage/fatigue",
    })
  }

  if (pendingCommissions > 50000) {
    brokerActions.push({
      id: "review-payouts",
      title: "Review Pending Payouts",
      description: "Agent commissions awaiting processing",
      priority: pendingCommissions > 100000 ? "high" : "medium",
      type: "financial",
      value: pendingCommissions,
      href: "/dashboard/financials/payouts",
    })
  }

  if (breakEvenAnalysis.avgBreakEvenMonth > 12) {
    brokerActions.push({
      id: "review-recruiting",
      title: "Review Recruiting Break-Even",
      description: `Average ${breakEvenAnalysis.avgBreakEvenMonth.toFixed(1)} months to profitability`,
      priority: breakEvenAnalysis.avgBreakEvenMonth > 18 ? "high" : "medium",
      type: "recruiting",
      href: "/dashboard/recruiting-roi",
    })
  }

  if (dealHealthSummary.at_risk > 0) {
    brokerActions.push({
      id: "review-at-risk",
      title: "Monitor At-Risk Deals",
      description: `${dealHealthSummary.at_risk} deals showing risk signals`,
      priority: "medium",
      type: "deal",
      href: "/dashboard/brokerage/deal-health",
    })
  }

  brokerActions.push({
    id: "view-team",
    title: "View Team Performance",
    description: `${agents?.length || 0} active agents`,
    priority: "low",
    type: "people",
    href: "/dashboard/team",
  })

  // Transform deal health for panel
  const dealHealthItems = dealHealthScores.map((d: any) => ({
    id: d.id,
    transactionId: d.transaction_id,
    propertyAddress: d.transactions?.property_address || "Unknown",
    score: d.overall_score,
    riskLevel: d.risk_level as "critical" | "at_risk" | "watch" | "healthy",
    aiNarrative: d.ai_narrative,
    closeDate: d.transactions?.close_date,
  }))

  // Transform fatigue buyers for panel
  const fatiguePanelBuyers = fatigueBuyers.slice(0, 5).map((b: any) => ({
    id: b.id,
    contactId: b.contact_id,
    firstName: b.contacts?.first_name || "",
    lastName: b.contacts?.last_name || "",
    fatigueScore: b.fatigue_score,
    status: b.fatigue_score >= 80 ? "critical" as const :
            b.fatigue_score >= 60 ? "warning" as const : "watch" as const,
    daysSearching: b.days_searching,
  }))

  // Real provider status from settings
  const providerStatus = [
    { name: "Direct Mail", status: (providerStatusResult.directMailEnabled ? "healthy" : "degraded") as "healthy" | "degraded" | "failing" },
    { name: "Video", status: (providerStatusResult.videoEnabled ? "healthy" : "degraded") as "healthy" | "degraded" | "failing" },
  ]
  const unassignedLeadsCount = unassignedLeadsResult.count ?? 0

  // Alias destructured names to match JSX references
  const licenseStatus = expirations as { expiringLicenses: any[]; expiredLicenses: any[] } ?? { expiringLicenses: [], expiredLicenses: [] }
  const forecast = forecastData as any

  // Agent performance (derived from dashboard agents)
  const agentPerformance = (agents || []).slice(0, 5).map((agent: any) => ({
    id: agent.id,
    name: `${agent.first_name || ""} ${agent.last_name || ""}`.trim() || "Agent",
    ytdGCI: agent.ytd_gci || 0,
    transactions: agent.transaction_count || 0,
    conversionRate: agent.conversion_rate || 0,
    trend: (agent.ytd_gci || 0) > (agent.last_year_gci || 0) ? "up" as const : "down" as const,
    status: (agent.ytd_gci || 0) > 200000 ? "top_performer" as const :
            (agent.ytd_gci || 0) > 100000 ? "on_track" as const :
            (agent.ytd_gci || 0) > 50000 ? "underperforming" as const : "at_risk" as const,
  }))

  const teamSummary = {
    totalAgents: agents?.length || 0,
    topPerformers: agentPerformance.filter((a: any) => a.status === "top_performer").length,
    atRisk: agentPerformance.filter((a: any) => a.status === "at_risk" || a.status === "underperforming").length,
    avgConversionRate: agentPerformance.length > 0
      ? agentPerformance.reduce((sum: number, a: any) => sum + a.conversionRate, 0) / agentPerformance.length
      : 0,
  }

  // Generate today's AI brief for the broker — synthesizes critical deals,
  // license expirations, compliance flags, unassigned leads into 3 priorities
  const brokerBrief = await generateUserTypeBrief({
    userType: "broker",
    userId: user.id,
    brokerageId,
  })

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Broker Command Center</h1>
          <p className="text-muted-foreground">Intelligence-driven brokerage operations</p>
        </div>
        {licenseStatus.expiringLicenses.length > 0 && (
          <Badge variant="destructive" className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {licenseStatus.expiringLicenses.length} License(s) Expiring
          </Badge>
        )}
      </div>

      {/* Today's Focus — AI Brief synthesizing what matters today */}
      <TodaysFocusCard brief={brokerBrief} />

      {/* Command Strip */}
      <BrokerCommandStrip
        priority={brokerPriority}
        summary={{
          criticalDeals: dealHealthSummary.critical,
          fatigueAlerts: fatigueAlerts.length,
          pendingPayouts: pendingCommissions || 0,
          recruitingROI: recruitingROI.avgROI,
        }}
      />

      {/* License Alerts */}
      {(licenseStatus.expiringLicenses.length > 0 || licenseStatus.expiredLicenses.length > 0) && (
        <Card className="border-orange-200 bg-orange-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 text-orange-800">
              <AlertTriangle className="h-5 w-5" />
              License Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-6 text-sm">
              {licenseStatus.expiredLicenses.length > 0 && (
                <div className="text-red-700">
                  <span className="font-bold">{licenseStatus.expiredLicenses.length}</span> Expired
                </div>
              )}
              {licenseStatus.expiringLicenses.length > 0 && (
                <div className="text-orange-700">
                  <span className="font-bold">{licenseStatus.expiringLicenses.length}</span> Expiring within 60 days
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending Commission Receivables */}
      {pendingDistributions.length > 0 && (
        <Card className="border-amber-200">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-amber-600" />
                Pending Commission Receivables
              </CardTitle>
              <div className="flex items-center gap-4 text-sm text-right">
                <div>
                  <p className="text-xs text-muted-foreground">Total Pending</p>
                  <p className="font-bold text-amber-700">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totalPendingBrokerageCommission)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Expected This Month</p>
                  <p className="font-bold text-green-700">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(expectedThisMonth)}
                  </p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {pendingDistributions.slice(0, 8).map((d: { id: string; transaction_id: string; calculated_amount: number | null; created_at: string }) => (
                <div key={d.id} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
                  <Link
                    href={`/dashboard/transactions/${d.transaction_id}/cda`}
                    className="text-sm text-foreground underline-offset-2 hover:underline"
                  >
                    View CDA
                  </Link>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">{new Date(d.created_at).toLocaleDateString()}</span>
                    <span className="font-medium">
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(d.calculated_amount ?? 0)}
                    </span>
                    <Badge variant="secondary" className="text-xs">Pending</Badge>
                  </div>
                </div>
              ))}
              {pendingDistributions.length > 8 && (
                <p className="text-xs text-muted-foreground text-center pt-1">
                  +{pendingDistributions.length - 8} more pending
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Source Performance CTA */}
      <Link href="/dashboard/analytics/source">
        <Card className="border-foreground/10 bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer">
          <CardContent className="py-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <BarChart3 className="h-5 w-5 text-foreground shrink-0" />
              <div>
                <p className="text-sm font-semibold">Source Performance</p>
                <p className="text-xs text-muted-foreground">
                  Attribution and ROI by acquisition source — raw, lead, and direct contact funnels
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
      </Link>

      {/* Intelligence Center CTA */}
      <Link href="/dashboard/brokerage/intelligence">
        <Card className="border-foreground/10 bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer">
          <CardContent className="py-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Brain className="h-5 w-5 text-foreground shrink-0" />
              <div>
                <p className="text-sm font-semibold">Intelligence Center</p>
                <p className="text-xs text-muted-foreground">
                  See your full operational picture — system health, farm, deals, market & more
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
      </Link>

      {/* Key Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Active Agents
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{agents?.length || 0}</div>
            <p className="text-xs text-muted-foreground">Licensed agents</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Transactions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{activeTransactions}</div>
            <p className="text-xs text-muted-foreground">Active deals</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              YTD GCI
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">${((totalGCI || 0) / 1000).toFixed(0)}K</div>
            <p className="text-xs text-muted-foreground">Gross commission</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Compliance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{complianceRate?.toFixed(0) || 0}%</div>
            <Progress value={complianceRate || 0} className="mt-2 h-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Forecast (90d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${((forecast?.likely || 0) / 1000).toFixed(0)}K</div>
            <p className="text-xs text-muted-foreground">Projected revenue</p>
          </CardContent>
        </Card>
      </div>

      {/* Intelligence Panels - 3 Column Layout */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left Column: Risk & Financial */}
        <div className="space-y-6">
          <BrokerRiskRadar signals={riskSignals} />
          <BrokerFinancialPulse
            ytdRevenue={totalGCI || 0}
            projectedRevenue={forecast?.likely || 0}
            marginPercent={15} // Would come from brokerage P&L
            pendingPayouts={pendingCommissions || 0}
            trend="up"
            trendPercent={12}
          />
          <BrokerProviderPressurePanel providers={providerStatus as any} />
        </div>

        {/* Middle Column: Deals & Fatigue */}
        <div className="space-y-6">
          <BrokerDealHealthPanel
            deals={dealHealthItems}
            summary={dealHealthSummary}
          />
          <BrokerFatiguePanel
            buyers={fatiguePanelBuyers}
            alertCount={fatigueAlerts.length}
            summary={fatigueSummary}
          />
        </div>

        {/* Right Column: Recruiting & Actions */}
        <div className="space-y-6">
          <BrokerBreakEvenCard
            avgBreakEvenMonth={breakEvenAnalysis.avgBreakEvenMonth}
            breakEvenMonths={breakEvenAnalysis.breakEvenMonths}
            trend={breakEvenAnalysis.avgBreakEvenMonth > 12 ? "worsening" : "stable"}
          />
          <BrokerRecruitingROIPanel
            summary={recruitingROI}
            costBreakdown={costBreakdown}
          />
          <BrokerRecruitingActionBar
            brokerageId={brokerageId}
            breakEvenAnalysis={breakEvenAnalysis as any}
            costBreakdown={costBreakdown}
          />
          <BrokerActionStack actions={brokerActions} />
        </div>
      </div>

      {/* Provider Health + Team Assignment — full width correction row */}
      <div className="grid lg:grid-cols-2 gap-6">
        <BrokerProviderHealthActions
          providerStatus={providerStatus}
          brokerageId={brokerageId}
        />
        <BrokerTeamAssignmentBar
          unassignedLeadsCount={unassignedLeadsCount}
          brokerageId={brokerageId}
        />
      </div>

      {/* Team Performance Panel */}
      <BrokerTeamPerformancePanel
        agents={agentPerformance}
        summary={teamSummary}
      />

      {/* Main Content Tabs */}
      <Tabs defaultValue="agents" className="space-y-4">
        <TabsList>
          <TabsTrigger value="agents">Agents ({agents?.length || 0})</TabsTrigger>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
        </TabsList>

        <TabsContent value="agents">
          <BrokerageAgentList agents={agents || []} />
        </TabsContent>

        <TabsContent value="revenue">
          <BrokerageRevenueChart totalRevenue={totalGCI || 0} />
        </TabsContent>

        <TabsContent value="compliance">
          <BrokerageComplianceOverview />
        </TabsContent>
      </Tabs>
    </div>
  )
}
