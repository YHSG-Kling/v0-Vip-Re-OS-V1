import { redirect } from "next/navigation"
import Link from "next/link"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Brain,
  Activity,
  Map,
  Plug,
  TrendingUp,
  BarChart3,
  Users,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Wrench,
  ExternalLink,
  TrendingDown,
  Minus,
} from "lucide-react"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Brokerage Intelligence Center",
  description: "Complete operational view — updated in real time",
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 1) return "just now"
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default async function BrokerageIntelligencePage() {
  const context = await getAgentContext()
  if (!context?.brokerageId) redirect("/login")
  if (context.userType !== "admin" && context.userType !== "broker" && context.userType !== "superadmin") {
    redirect("/dashboard")
  }

  const { brokerageId } = context
  const supabase = await createClient()

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const last24h = new Date(Date.now() - 86_400_000).toISOString()
  const last7d = new Date(Date.now() - 7 * 86_400_000).toISOString()

  // All 7 data sources loaded in parallel
  const [
    systemErrorsResult,
    farmMetricsResult,
    providerStatusResult,
    dealHealthResult,
    patternCountResult,
    latestMarketInsightResult,
    recruitingCostsResult,
  ] = await Promise.all([
    // 1. System: unresolved automation errors in last 24h
    supabase
      .from("automation_errors")
      .select("id, severity, workflow_name")
      .eq("brokerage_id", brokerageId)
      .eq("status", "unresolved")
      .gt("created_at", last24h),

    // 2. Farm: top 5 territories by ROI
    supabase
      .from("territory_metrics")
      .select("zip_code, lead_count, qualified_lead_count, roi, metric_date")
      .eq("brokerage_id", brokerageId)
      .order("metric_date", { ascending: false })
      .limit(5),

    // 3. Provider: integration connection statuses
    supabase
      .from("brokerage_integrations")
      .select("provider_name, provider_type, status")
      .eq("brokerage_id", brokerageId),

    // 4. Deal health: high/critical risk transactions
    supabase
      .from("deal_health_scores")
      .select("id, transaction_id, risk_level, overall_score")
      .eq("brokerage_id", brokerageId)
      .in("risk_level", ["critical", "at_risk"])
      .order("overall_score", { ascending: true })
      .limit(5),

    // 5. Pattern detections this week
    supabase
      .from("pattern_detections")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .gt("created_at", last7d),

    // 6. Latest market insight
    supabase
      .from("market_insights")
      .select("headline, summary, price_trend, dom_trend, inventory_level, key_stats, generated_at, market_area")
      .eq("brokerage_id", brokerageId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // 7. Recruiting costs this month
    supabase
      .from("recruiting_costs")
      .select("amount")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startOfMonth),
  ])

  const systemErrors = systemErrorsResult.data || []
  const farmMetrics = farmMetricsResult.data || []
  const providerIntegrations = providerStatusResult.data || []
  const highRiskDeals = dealHealthResult.data || []
  const patternCount = patternCountResult.count ?? 0
  const marketInsight = latestMarketInsightResult.data
  const recruitingCosts = recruitingCostsResult.data || []

  const totalRecruitingCost = recruitingCosts.reduce((sum, r) => sum + (r.amount || 0), 0)

  // Provider status: known providers to check
  const knownProviders = [
    { key: "ghl", label: "CRM/GHL", matchType: "ghl" },
    { key: "did", label: "D-ID Video", matchType: "did" },
    { key: "idx", label: "IDX", matchType: "idx" },
    { key: "dotloop", label: "Dotloop", matchType: "dotloop" },
    { key: "stripe", label: "Stripe", matchType: "stripe" },
  ]

  const providerMap = providerIntegrations.reduce<Record<string, string>>((acc, p) => {
    const key = (p.provider_type || p.provider_name || "").toLowerCase()
    acc[key] = p.status
    return acc
  }, {})

  const providerStatuses = knownProviders.map((p) => {
    const matchedKey = Object.keys(providerMap).find((k) => k.includes(p.matchType))
    const status = matchedKey ? providerMap[matchedKey] : null
    return {
      ...p,
      connected: status === "active" || status === "connected" || status === "healthy",
    }
  })

  const connectedCount = providerStatuses.filter((p) => p.connected).length
  const disconnectedCount = providerStatuses.length - connectedCount

  // Severity color helpers
  const errorSeverityColor = systemErrors.length === 0
    ? "bg-green-100 text-green-800 border-green-200"
    : systemErrors.length <= 3
    ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-red-100 text-red-800 border-red-200"

  const systemStatusColor = systemErrors.length === 0
    ? "text-green-700"
    : systemErrors.length <= 3
    ? "text-amber-700"
    : "text-red-700"

  const topFarmTerritory = farmMetrics.reduce<(typeof farmMetrics)[0] | null>((best, t) => {
    if (!best) return t
    return (t.roi || 0) > (best.roi || 0) ? t : best
  }, null)

  const priceTrendIcon = marketInsight?.price_trend === "up"
    ? <TrendingUp className="h-4 w-4 text-green-600" />
    : marketInsight?.price_trend === "down"
    ? <TrendingDown className="h-4 w-4 text-red-600" />
    : <Minus className="h-4 w-4 text-muted-foreground" />

  return (
    <div className="container mx-auto p-6 space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Brain className="h-6 w-6 text-foreground" />
            <h1 className="text-2xl font-bold tracking-tight">Brokerage Intelligence</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Your complete operational view — updated in real time
          </p>
        </div>
        <Link href="/dashboard/brokerage">
          <Button variant="outline" size="sm" className="gap-1.5 shrink-0">
            <ArrowRight className="h-3.5 w-3.5" />
            Broker Dashboard
          </Button>
        </Link>
      </div>

      {/* Command Strip */}
      <div className="flex flex-wrap gap-2">
        {[
          { label: "System Health", href: "/dashboard/system", icon: Wrench },
          { label: "Farm Intel", href: "/dashboard/admin/farm-intelligence", icon: Map },
          { label: "Providers", href: "/dashboard/admin/provider-intelligence", icon: Plug },
          { label: "Market", href: "/dashboard/market-insights", icon: TrendingUp },
          { label: "Patterns", href: "/dashboard/patterns", icon: Activity },
          { label: "Recruiting", href: "/dashboard/recruiting-roi", icon: Users },
        ].map(({ label, href, icon: Icon }) => (
          <Link key={href} href={href}>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs">
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Button>
          </Link>
        ))}
      </div>

      {/* Alert Strip */}
      {(systemErrors.length > 0 || highRiskDeals.length > 0 || patternCount > 0) && (
        <div className="flex flex-wrap gap-2">
          {systemErrors.length > 0 && (
            <Link href="/dashboard/system">
              <Badge variant="destructive" className="cursor-pointer gap-1 px-3 py-1 text-xs">
                <AlertTriangle className="h-3 w-3" />
                {systemErrors.length} system error{systemErrors.length !== 1 ? "s" : ""}
              </Badge>
            </Link>
          )}
          {highRiskDeals.length > 0 && (
            <Link href="/dashboard/brokerage/deal-health">
              <Badge className="cursor-pointer gap-1 px-3 py-1 text-xs bg-amber-500 hover:bg-amber-600 text-white border-0">
                <AlertTriangle className="h-3 w-3" />
                {highRiskDeals.length} deal{highRiskDeals.length !== 1 ? "s" : ""} need attention
              </Badge>
            </Link>
          )}
          {patternCount > 0 && (
            <Link href="/dashboard/patterns">
              <Badge className="cursor-pointer gap-1 px-3 py-1 text-xs bg-blue-500 hover:bg-blue-600 text-white border-0">
                <Brain className="h-3 w-3" />
                {patternCount} pattern{patternCount !== 1 ? "s" : ""} this week
              </Badge>
            </Link>
          )}
        </div>
      )}

      {/* Intelligence Grid — 2x2 */}
      <div className="grid md:grid-cols-2 gap-6">

        {/* Card 1: System Health */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                System Health
              </CardTitle>
              <Link href="/dashboard/system">
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                  <ExternalLink className="h-3 w-3" />
                  View
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className={`flex items-center justify-between rounded-md border px-3 py-2 ${errorSeverityColor}`}>
              <span className="text-xs font-medium">Unresolved errors (last 24h)</span>
              <span className="text-lg font-bold">{systemErrors.length}</span>
            </div>
            {systemErrors.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                All systems operational
              </div>
            ) : (
              <div className="space-y-1.5">
                {systemErrors.slice(0, 3).map((err) => (
                  <div key={err.id} className="flex items-center justify-between text-xs">
                    <span className="truncate text-muted-foreground max-w-[200px]">
                      {err.workflow_name || "Unknown workflow"}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-xs shrink-0 ml-2 ${
                        err.severity === "critical"
                          ? "border-red-300 text-red-700"
                          : "border-amber-300 text-amber-700"
                      }`}
                    >
                      {err.severity}
                    </Badge>
                  </div>
                ))}
                {systemErrors.length > 3 && (
                  <p className={`text-xs ${systemStatusColor}`}>
                    +{systemErrors.length - 3} more
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Card 2: Farm Performance */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Map className="h-4 w-4" />
                Farm Intelligence
              </CardTitle>
              <Link href="/dashboard/admin/farm-intelligence">
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                  <ExternalLink className="h-3 w-3" />
                  View
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {farmMetrics.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  No territory performance data yet.
                </p>
                <Link href="/dashboard/admin/farm-intelligence">
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                    Set Up Territories
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                {topFarmTerritory && (
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="text-xs">
                      Best: {topFarmTerritory.zip_code}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {topFarmTerritory.roi != null ? `${(topFarmTerritory.roi * 100).toFixed(0)}% ROI` : ""}
                    </span>
                  </div>
                )}
                <div className="space-y-1.5">
                  {farmMetrics.slice(0, 3).map((t) => (
                    <div key={t.zip_code + t.metric_date} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-foreground">{t.zip_code}</span>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>{t.lead_count ?? 0} leads</span>
                        {t.roi != null && (
                          <Badge variant="outline" className="text-xs border-green-300 text-green-700">
                            {(t.roi * 100).toFixed(0)}% ROI
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Card 3: Deal Health */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Deal Health
              </CardTitle>
              <Link href="/dashboard/brokerage/deal-health">
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                  <ExternalLink className="h-3 w-3" />
                  View
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {highRiskDeals.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                All deals healthy
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm text-amber-700">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {highRiskDeals.length} transaction{highRiskDeals.length !== 1 ? "s" : ""} at risk
                </div>
                <div className="space-y-1.5">
                  {highRiskDeals.slice(0, 3).map((d) => (
                    <div key={d.id} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground font-mono text-xs truncate max-w-[160px]">
                        {d.transaction_id?.slice(0, 8)}...
                      </span>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-muted-foreground">score {d.overall_score}</span>
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            d.risk_level === "critical"
                              ? "border-red-300 text-red-700"
                              : "border-amber-300 text-amber-700"
                          }`}
                        >
                          {d.risk_level}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Card 4: Market Pulse */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Market Intelligence
              </CardTitle>
              <Link href="/dashboard/market-insights">
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                  <ExternalLink className="h-3 w-3" />
                  View
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!marketInsight ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">No market data generated yet.</p>
                <Link href="/dashboard/market-insights">
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                    Set Market Area
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                <p className="text-sm font-medium line-clamp-2">{marketInsight.headline}</p>
                <div className="flex flex-wrap gap-3 text-xs">
                  <div className="flex items-center gap-1">
                    {priceTrendIcon}
                    <span className="text-muted-foreground capitalize">
                      Price {marketInsight.price_trend || "flat"}
                    </span>
                  </div>
                  {marketInsight.dom_trend && (
                    <div className="text-muted-foreground">
                      DOM {marketInsight.dom_trend}
                    </div>
                  )}
                  {marketInsight.inventory_level && (
                    <Badge variant="secondary" className="text-xs">
                      {marketInsight.inventory_level} inventory
                    </Badge>
                  )}
                </div>
                {marketInsight.key_stats && typeof marketInsight.key_stats === "object" && (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {Object.entries(marketInsight.key_stats as Record<string, string | number>)
                      .slice(0, 4)
                      .map(([k, v]) => (
                        <div key={k} className="text-xs">
                          <span className="text-muted-foreground capitalize">{k.replace(/_/g, " ")}: </span>
                          <span className="font-medium">{String(v)}</span>
                        </div>
                      ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Generated {relativeTime(marketInsight.generated_at)}
                  {marketInsight.market_area ? ` · ${marketInsight.market_area}` : ""}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Provider Status Row */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Plug className="h-4 w-4" />
              Provider Status
              <span className="text-xs font-normal text-muted-foreground ml-1">
                Connected: {connectedCount} | Disconnected: {disconnectedCount}
              </span>
            </CardTitle>
            <Link href="/dashboard/settings/integrations">
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                Manage Integrations
                <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            {providerStatuses.map((p) => (
              <div key={p.key} className="flex items-center gap-1.5 text-sm">
                {p.connected ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className={p.connected ? "text-foreground" : "text-muted-foreground"}>
                  {p.label}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recruiting Summary Row */}
      <div className="rounded-md border px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Users className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-medium">Recruiting Investment This Month</p>
            <p className="text-xs text-muted-foreground">
              ${totalRecruitingCost.toLocaleString()} across {recruitingCosts.length} cost entr{recruitingCosts.length !== 1 ? "ies" : "y"}
            </p>
          </div>
        </div>
        <Link href="/dashboard/recruiting-roi">
          <Button variant="outline" size="sm" className="gap-1.5 text-xs shrink-0">
            Recruiting ROI
            <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </div>

      {/* Bottom Quick Launch */}
      <div className="grid sm:grid-cols-3 gap-4">
        {[
          {
            label: "Recruiting ROI",
            description: "Agent ROI, break-even & cost analysis",
            href: "/dashboard/recruiting-roi",
            icon: Users,
          },
          {
            label: "Patterns Dashboard",
            description: "Behavioral signal detections this week",
            href: "/dashboard/patterns",
            icon: Activity,
          },
          {
            label: "Brokerage Analytics",
            description: "Revenue, compliance & team performance",
            href: "/analytics",
            icon: BarChart3,
          },
        ].map(({ label, description, href, icon: Icon }) => (
          <Link key={href} href={href}>
            <Card className="hover:bg-muted/40 transition-colors cursor-pointer h-full">
              <CardContent className="pt-4 pb-4 flex items-start gap-3">
                <Icon className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
