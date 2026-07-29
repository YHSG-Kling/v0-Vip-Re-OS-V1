import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { 
  TrendingUp, 
  Users, 
  Home, 
  DollarSign,
  BarChart3,
  PieChart,
  Calendar,
  Target,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Database,
} from "lucide-react"
import { createServiceClient } from "@/lib/supabase/service"
import { getPredictionAccuracyReport, composePredictionTrustChip, type PredictionAccuracyReport } from "@/lib/analytics/prediction-accuracy"
import { PredictionAccuracyPanel } from "@/components/analytics/prediction-accuracy-panel"

export const dynamic = "force-dynamic"

export default async function AnalyticsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Get user profile
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  // pass 11: contacts/listings/transactions/activities.agent_id FK agents(id),
  // NOT users(id) — every filter below used user.id and returned ZERO for every
  // agent (the whole analytics page rendered empty). Resolve the agents.id once.
  const { resolveAgentId } = await import("@/lib/kernel/agent-identity")
  const agentId = (await resolveAgentId(supabase as any, user.id)) ?? user.id

  // Fetch comprehensive stats
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  const [
    contactsResult, 
    listingsResult, 
    transactionsResult,
    prevTransactionsResult,
    leadSourcesResult,
    recentActivityResult
  ] = await Promise.all([
    supabase.from("contacts").select("id", { count: "exact", head: true }).eq("agent_id", agentId),
    supabase.from("listings").select("id, status", { count: "exact" }).eq("agent_id", agentId),
    supabase.from("transactions")
      .select("id, contract_price:purchase_price, status, close_date")
      .eq("agent_id", agentId)
      .gte("created_at", thirtyDaysAgo),
    supabase.from("transactions")
      .select("id, contract_price:purchase_price")
      .eq("agent_id", agentId)
      .gte("created_at", sixtyDaysAgo)
      .lt("created_at", thirtyDaysAgo)
      .eq("status", "closed"),
    supabase.from("contacts")
      .select("source")
      .eq("agent_id", agentId)
      .not("source", "is", null),
    supabase.from("activities")
      .select("id, title, activity_type, created_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(10)
  ])

  const totalContacts = contactsResult.count || 0
  const activeListings = listingsResult.data?.filter(l => l.status === "active").length || 0
  const totalListings = listingsResult.count || 0
  
  const currentMonthClosed = transactionsResult.data?.filter(t => t.status === "closed") || []
  const closedTransactions = currentMonthClosed.length
  const totalVolume = currentMonthClosed.reduce((sum, tx) => sum + (tx.contract_price || 0), 0)
  
  const prevMonthVolume = prevTransactionsResult.data?.reduce((sum, tx) => sum + (tx.contract_price || 0), 0) || 0
  const volumeChange = prevMonthVolume > 0 ? ((totalVolume - prevMonthVolume) / prevMonthVolume * 100) : 0

  // Calculate lead source distribution
  const leadSources: Record<string, number> = {}
  leadSourcesResult.data?.forEach(contact => {
    const source = contact.source || "unknown"
    leadSources[source] = (leadSources[source] || 0) + 1
  })
  const topSources = Object.entries(leadSources)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)

  // PREDICTION ACCURACY (round 35) — the tenant-scoped mount of the ONE trust
  // surface (same component as the superadmin platform page, keep-one). The
  // accuracy ledgers are service-role-only by design (they match the
  // net_sheet_reconciliations RLS pattern), so this reads through the service
  // client SCOPED HARD to the viewer's own brokerage_id from their profile.
  let predictionAccuracy: PredictionAccuracyReport | null = null
  if (profile?.brokerage_id) {
    try {
      predictionAccuracy = await getPredictionAccuracyReport(
        createServiceClient() as any,
        { brokerageId: profile.brokerage_id },
      )
    } catch { /* the page stands without the panel — never a fabricated one */ }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="px-6 py-4">
          <h1 className="text-2xl font-bold text-foreground">Analytics Intelligence</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track your performance metrics and business intelligence
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Command Strip */}
        <div className="flex flex-wrap items-center gap-3 p-4 bg-muted/30 border border-border rounded-lg">
          <span className="text-sm font-semibold text-foreground">Analytics Operations</span>
          <div className="flex gap-2 flex-wrap">
            <Link href="/dashboard/financials">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <DollarSign className="h-3 w-3" />
                Financial Reports
              </Button>
            </Link>
            <Link href="/dashboard/motivation">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <BarChart3 className="h-3 w-3" />
                Leaderboard
              </Button>
            </Link>
            <Link href="/dashboard/campaigns/roi">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Target className="h-3 w-3" />
                Campaign ROI
              </Button>
            </Link>
            <Link href="/dashboard/patterns">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <PieChart className="h-3 w-3" />
                Pattern Analysis
              </Button>
            </Link>
            <Link href="/dashboard/analytics/source">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Database className="h-3 w-3" />
                Source Analytics
              </Button>
            </Link>
          </div>
        </div>

        {/* Status Radar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/10">
                    <Users className="h-5 w-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{totalContacts.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Total Contacts</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-green-500/10">
                    <Home className="h-5 w-5 text-green-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{activeListings}</p>
                    <p className="text-xs text-muted-foreground">Active Listings</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-purple-500/10">
                    <TrendingUp className="h-5 w-5 text-purple-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{closedTransactions}</p>
                    <p className="text-xs text-muted-foreground">Closed (30d)</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10">
                    <DollarSign className="h-5 w-5 text-emerald-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">
                      ${(totalVolume / 1000000).toFixed(1)}M
                    </p>
                    <p className="text-xs text-muted-foreground">Volume (30d)</p>
                  </div>
                </div>
                {volumeChange !== 0 && (
                  <div className={`flex items-center gap-1 text-xs ${volumeChange > 0 ? "text-green-500" : "text-red-500"}`}>
                    {volumeChange > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {Math.abs(volumeChange).toFixed(0)}%
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Intelligence Panels */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Lead Source Distribution */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <PieChart className="h-5 w-5" />
                Lead Sources
              </CardTitle>
              <CardDescription>Where your contacts come from</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {topSources.length > 0 ? (
                  topSources.map(([source, count], i) => (
                    <div key={source} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-3 h-3 rounded-full ${
                          i === 0 ? "bg-blue-500" : 
                          i === 1 ? "bg-green-500" : 
                          i === 2 ? "bg-purple-500" : 
                          i === 3 ? "bg-amber-500" : "bg-gray-400"
                        }`} />
                        <span className="text-sm text-foreground capitalize">{source}</span>
                      </div>
                      <span className="text-sm font-medium text-muted-foreground">{count}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No lead source data available
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Pipeline Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Pipeline Summary
              </CardTitle>
              <CardDescription>Current deal pipeline status</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <span className="text-sm text-foreground">Total Listings</span>
                  <span className="text-lg font-bold text-foreground">{totalListings}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-green-500/10">
                  <span className="text-sm text-foreground">Active</span>
                  <span className="text-lg font-bold text-green-600">{activeListings}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-blue-500/10">
                  <span className="text-sm text-foreground">Pending</span>
                  <span className="text-lg font-bold text-blue-600">
                    {transactionsResult.data?.filter(t => t.status === "pending").length || 0}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Recent Activity
              </CardTitle>
              <CardDescription>Your latest actions</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {recentActivityResult.data && recentActivityResult.data.length > 0 ? (
                  recentActivityResult.data.slice(0, 5).map((activity) => (
                    <div key={activity.id} className="flex items-start gap-2 p-2 rounded border border-border">
                      <div className="w-2 h-2 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-foreground truncate">{activity.title ?? activity.activity_type}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(activity.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No recent activity
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
        {/* PREDICTION ACCURACY — the tenant-scoped trust surface (keep-one
            component with the superadmin platform mount). Honest per-rail
            empty states; nothing renders an invented number. */}
        {predictionAccuracy && (
          <PredictionAccuracyPanel
            report={predictionAccuracy}
            scopeLabel="your brokerage"
            trustChip={composePredictionTrustChip(predictionAccuracy.rails)}
          />
        )}

        {/* Source Performance Entry Card */}
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Database className="h-5 w-5" />
              Source Analytics
            </CardTitle>
            <CardDescription>Attribution and ROI by acquisition source family</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: "Direct Contact", desc: "Website, QR, open house, referral", dot: "bg-emerald-500" },
              { label: "Lead Sources", desc: "Manual entry, vendor feeds, paid", dot: "bg-blue-500" },
              { label: "Raw Acquisition", desc: "Scraped, imported, purchased", dot: "bg-orange-500" },
            ].map(item => (
              <div key={item.label} className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${item.dot} shrink-0`} />
                <div>
                  <p className="text-sm font-medium text-foreground">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                </div>
              </div>
            ))}
            <Link href="/dashboard/analytics/source">
              <Button size="sm" variant="outline" className="w-full mt-2 text-xs gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" />
                Open Source Analytics
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
