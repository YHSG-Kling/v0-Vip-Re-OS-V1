import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Suspense } from "react"
import {
  DollarSign,
  TrendingUp,
  Users,
  Building2,
  Percent,
  PieChart,
  BarChart3,
  Target,
  AlertTriangle,
  CheckCircle2,
  Award,
} from "lucide-react"
import { PLExpenseChart } from "./pl-expense-chart"
import { PLTrendChart } from "./pl-trend-chart"
import { ForecastChart } from "./forecast-chart"

export const dynamic = "force-dynamic"

// ─── BROKERAGE P&L DASHBOARD ─────────────────────────────────────────────────
// ROLE GATE: broker + admin + superadmin only
// Tables: brokerage_earnings, brokerage_p_l, team_earnings, agents, commissions

export default async function BrokeragePLPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Get user profile and enforce role gate
  const { data: profile } = await supabase
    .from("users")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  // RBAC: Only broker, admin, superadmin can access
  const allowedRoles = ["broker", "admin", "superadmin"]
  if (!profile || !allowedRoles.includes(profile.role || "")) {
    redirect("/dashboard/financials/agent")
  }

  if (!profile.brokerage_id) redirect("/onboarding")

  // ─── PARALLEL DATA FETCHING ────────────────────────────────────────────────
  const [
    mtdEarnings,
    ytdEarnings,
    latestPL,
    teamEarnings,
    agents,
    last12MonthsEarnings,
    forecasts,
  ] = await Promise.all([
    // MTD brokerage earnings
    supabase
      .from("brokerage_earnings")
      .select("*")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("period_type", "mtd")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(r => r.data),

    // YTD brokerage earnings
    supabase
      .from("brokerage_earnings")
      .select("*")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("period_type", "ytd")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(r => r.data),

    // Latest P&L breakdown
    supabase
      .from("brokerage_p_l")
      .select("*")
      .eq("brokerage_id", profile.brokerage_id)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(r => r.data),

    // Team earnings MTD
    supabase
      .from("team_earnings")
      .select(`
        id,
        team_id,
        gross_commission,
        team_net,
        agent_count,
        transaction_count,
        period_label,
        teams:team_id(id, name)
      `)
      .eq("brokerage_id", profile.brokerage_id)
      .eq("period_type", "mtd")
      .order("gross_commission", { ascending: false })
      .then(r => r.data || []),

    // Agents with cap status
    supabase
      .from("agents")
      .select("id, cap_progress, cap_amount, user_id, ytd_gci")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("is_active", true)
      .then(r => r.data || []),

    // Last 12 months brokerage earnings for trend chart
    supabase
      .from("brokerage_earnings")
      .select("period_label, gross_commission_income, brokerage_net, agent_splits_paid")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("period_type", "monthly")
      .order("period_label", { ascending: true })
      .limit(12)
      .then(r => r.data || []),

    // Cashflow forecasts (6 months)
    supabase
      .from("cashflow_forecasts")
      .select("forecast_month, projected_revenue, actual_revenue")
      .eq("brokerage_id", profile.brokerage_id)
      .order("forecast_month", { ascending: true })
      .limit(6)
      .then(r => r.data || []),
  ])

  // ─── COMPUTE CAP SUMMARY ───────────────────────────────────────────────────
  const capSummary = {
    belowCap: agents.filter(a => (a.cap_progress || 0) < 100).length,
    atCap: agents.filter(a => (a.cap_progress || 0) >= 100 && (a.cap_progress || 0) < 101).length,
    postCap: agents.filter(a => (a.cap_progress || 0) >= 101).length,
    recentlyCapped: agents.filter(a => (a.cap_progress || 0) >= 100),
    totalAgents: agents.length,
    totalCapRevenue: agents.reduce((sum, a) => {
      const capPaid = ((a.cap_progress || 0) / 100) * (a.cap_amount || 0)
      return sum + Math.min(capPaid, a.cap_amount || 0)
    }, 0),
    totalCapPotential: agents.reduce((sum, a) => sum + (a.cap_amount || 0), 0),
  }

  // Format currency
  const formatCurrency = (val: number | null | undefined) => {
    if (val == null) return "$0"
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val)
  }

  const formatPercent = (val: number | null | undefined) => {
    if (val == null) return "0%"
    return `${val.toFixed(1)}%`
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Brokerage P&L</h1>
          <p className="text-muted-foreground mt-1">
            Financial overview, team breakdown, and forecasting
          </p>
        </div>
        <Badge variant="outline" className="text-sm">
          {capSummary.totalAgents} Active Agents
        </Badge>
      </div>

      {/* ─── SECTION 1: BROKERAGE KPI ROW ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              GCI MTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(mtdEarnings?.gross_commission_income)}
            </div>
            <p className="text-xs text-muted-foreground">Gross Commission Income</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              GCI YTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(ytdEarnings?.gross_commission_income)}
            </div>
            <p className="text-xs text-muted-foreground">Year to Date</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Brokerage Net MTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(mtdEarnings?.brokerage_net)}
            </div>
            <p className="text-xs text-muted-foreground">After Agent Splits</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Brokerage Net YTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(ytdEarnings?.brokerage_net)}
            </div>
            <p className="text-xs text-muted-foreground">Year to Date</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Percent className="h-4 w-4" />
              Profit Margin
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(latestPL?.profit_margin_pct || 0) >= 20 ? "text-green-600" : (latestPL?.profit_margin_pct || 0) >= 10 ? "text-amber-600" : "text-red-600"}`}>
              {formatPercent(latestPL?.profit_margin_pct)}
            </div>
            <p className="text-xs text-muted-foreground">Net Profit / GCI</p>
          </CardContent>
        </Card>
      </div>

      {/* ─── SECTION 2: P&L EXPENSE BREAKDOWN ─────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PieChart className="h-5 w-5" />
              Expense Breakdown
            </CardTitle>
            <CardDescription>
              {latestPL?.period_label || "Current Period"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <PLExpenseChart
                agentSplits={latestPL?.agent_splits_paid || 0}
                techExpenses={latestPL?.tech_expenses || 0}
                marketingExpenses={latestPL?.marketing_expenses || 0}
                officeExpenses={latestPL?.office_expenses || 0}
                operatingExpenses={latestPL?.operating_expenses || 0}
              />
            </Suspense>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>P&L Line Items</CardTitle>
            <CardDescription>
              Period: {latestPL?.period_label || "—"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center py-2 border-b">
                <span className="font-medium">Gross Commission Income</span>
                <span className="font-bold">{formatCurrency(latestPL?.gross_commission_income)}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b text-muted-foreground">
                <span>Agent Splits Paid</span>
                <span className="text-red-600">-{formatCurrency(latestPL?.agent_splits_paid)}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b text-muted-foreground">
                <span>Operating Expenses</span>
                <span className="text-red-600">-{formatCurrency(latestPL?.operating_expenses)}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b text-muted-foreground">
                <span>Technology Expenses</span>
                <span className="text-red-600">-{formatCurrency(latestPL?.tech_expenses)}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b text-muted-foreground">
                <span>Marketing Expenses</span>
                <span className="text-red-600">-{formatCurrency(latestPL?.marketing_expenses)}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b text-muted-foreground">
                <span>Office Expenses</span>
                <span className="text-red-600">-{formatCurrency(latestPL?.office_expenses)}</span>
              </div>
              <div className="flex justify-between items-center py-3 bg-muted/50 rounded-lg px-3 mt-2">
                <span className="font-bold">Net Profit</span>
                <div className="text-right">
                  <span className={`font-bold text-lg ${(latestPL?.net_profit || 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {formatCurrency(latestPL?.net_profit)}
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {formatPercent(latestPL?.profit_margin_pct)} margin
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── SECTION 3: PER-TEAM REVENUE TABLE ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Team Revenue (MTD)
          </CardTitle>
          <CardDescription>
            Revenue breakdown by team
          </CardDescription>
        </CardHeader>
        <CardContent>
          {teamEarnings.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground">
                    <th className="pb-3 pr-4">Team Name</th>
                    <th className="pb-3 pr-4 text-right">Gross Commission</th>
                    <th className="pb-3 pr-4 text-right">Team Net</th>
                    <th className="pb-3 pr-4 text-right">Agents</th>
                    <th className="pb-3 text-right">Transactions</th>
                  </tr>
                </thead>
                <tbody>
                  {teamEarnings.map((team: any) => (
                    <tr key={team.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 pr-4 font-medium">
                        {team.teams?.name || "Unnamed Team"}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {formatCurrency(team.gross_commission)}
                      </td>
                      <td className="py-3 pr-4 text-right text-green-600">
                        {formatCurrency(team.team_net)}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {team.agent_count || 0}
                      </td>
                      <td className="py-3 text-right">
                        {team.transaction_count || 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No team earnings data available for this period
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── SECTION 4: AGENT CAPS SUMMARY ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Agent Caps Summary
          </CardTitle>
          <CardDescription>
            Cap status distribution and revenue impact
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <span className="text-sm text-amber-800">Below Cap</span>
              </div>
              <p className="text-2xl font-bold mt-1">{capSummary.belowCap}</p>
            </div>
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-600" />
                <span className="text-sm text-blue-800">At Cap</span>
              </div>
              <p className="text-2xl font-bold mt-1">{capSummary.atCap}</p>
            </div>
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 text-green-600" />
                <span className="text-sm text-green-800">Post-Cap</span>
              </div>
              <p className="text-2xl font-bold mt-1">{capSummary.postCap}</p>
            </div>
            <div className="p-4 bg-muted rounded-lg">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Cap Revenue</span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {formatCurrency(capSummary.totalCapRevenue)}
              </p>
              <p className="text-xs text-muted-foreground">
                of {formatCurrency(capSummary.totalCapPotential)} potential
              </p>
            </div>
          </div>

          {/* Cap Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Brokerage Cap Revenue Progress</span>
              <span className="font-medium">
                {capSummary.totalCapPotential > 0
                  ? ((capSummary.totalCapRevenue / capSummary.totalCapPotential) * 100).toFixed(1)
                  : 0}%
              </span>
            </div>
            <Progress
              value={
                capSummary.totalCapPotential > 0
                  ? (capSummary.totalCapRevenue / capSummary.totalCapPotential) * 100
                  : 0
              }
              className="h-3"
            />
          </div>

          {/* Recently Capped Agents */}
          {capSummary.recentlyCapped.length > 0 && (
            <div className="mt-6">
              <h4 className="text-sm font-medium mb-3">Agents Who Hit Cap This Year</h4>
              <div className="flex flex-wrap gap-2">
                {capSummary.recentlyCapped.slice(0, 10).map((agent: any) => (
                  <Badge key={agent.id} variant="secondary" className="flex items-center gap-1">
                    <Award className="h-3 w-3 text-green-600" />
                    Agent {agent.id.slice(0, 8)}
                  </Badge>
                ))}
                {capSummary.recentlyCapped.length > 10 && (
                  <Badge variant="outline">+{capSummary.recentlyCapped.length - 10} more</Badge>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── SECTION 5: 12-MONTH P&L TREND ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            12-Month P&L Trend
          </CardTitle>
          <CardDescription>
            GCI vs Brokerage Net vs Operating Expenses
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-80 w-full" />}>
            <PLTrendChart data={last12MonthsEarnings} />
          </Suspense>
        </CardContent>
      </Card>

      {/* ─── SECTION 6: 6-MONTH FORECAST ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            6-Month Forecast
          </CardTitle>
          <CardDescription>
            Projected vs actual revenue
          </CardDescription>
        </CardHeader>
        <CardContent>
          {forecasts.length > 0 ? (
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <ForecastChart data={forecasts} />
            </Suspense>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Forecast will appear once 3 months of data is available
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
