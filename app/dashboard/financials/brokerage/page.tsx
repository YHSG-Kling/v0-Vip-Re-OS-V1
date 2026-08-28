import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Suspense } from "react"
import { generateBrokeragePnl } from "@/lib/intelligence/brokerage-pnl"
import { Handshake } from "lucide-react"
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
import { AgentPLTable } from "./agent-pl-table"
import {
  FinancialCommandStrip,
  MarginBreakdownPanel,
  FinancialActionStack,
  ProfitLossReportPanel,
  type FinancialPriority,
  type FinancialAction,
} from "../components/os"
import { getAgentPLSummary } from "@/app/actions/pl-truth-engine"
import { ScopedExpenseEntry } from "./scoped-expense-entry"

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
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  // BROKERAGE-WIDE MONEY (m472) — this is the whole brokerage's P&L. The ONE
  // finance roster: excludes team_lead per the owner's ruling, and admits
  // broker_owner, whom the local literal refused from their own books.
  if (!profile || !isBrokerageFinanceAdmin(profile as { user_type?: string | null })) {
    redirect("/dashboard/financials/agent")
  }

  if (!profile.brokerage_id) redirect("/dashboard/onboarding")

  // pass 12: the P&L report panel needs the broker's agents.id (financial tables
  // key on agents, not users). Brokers who also produce have an agents row.
  const { resolveAgentId } = await import("@/lib/kernel/agent-identity")
  const brokerAgentId = await resolveAgentId(supabase as any, user.id)

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
      .eq("period_type", "monthly")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(r => r.data),

    // YTD brokerage earnings
    supabase
      .from("brokerage_earnings")
      .select("*")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("period_type", "annual")
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

    // Active agents. `cap_progress` and `cap_amount` are NO LONGER READ from
    // here — they are the copy the commission engine never applied and they are
    // being dropped. Cap state comes from agent_cap_tracking, read below.
    supabase
      .from("agents")
      .select("id, user_id, ytd_gci")
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

    // Use monthly brokerage_earnings as forecast proxy (cashflow_forecasts doesn't exist)
    supabase
      .from("brokerage_earnings")
      .select("period_label, gross_commission_income, brokerage_net")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("period_type", "monthly")
      .order("period_label", { ascending: false })
      .limit(6)
      .then(r => r.data || []),
  ])

  // Teams for the scoped expense entry (team-scope option) + the most recent
  // brokerage/team-scoped expense rows (agent_id NULL = not an agent's book).
  const [{ data: teamOptions }, { data: recentOpExpenses }] = await Promise.all([
    supabase.from("teams").select("id, name").eq("brokerage_id", profile.brokerage_id).order("name").limit(100),
    supabase
      .from("business_expenses")
      .select("id, category, description, amount, expense_date, team_id")
      .eq("brokerage_id", profile.brokerage_id)
      .is("agent_id", null)
      .order("expense_date", { ascending: false })
      .limit(8),
  ])

  // ─── COMPUTE CAP SUMMARY, FROM THE LEDGER THE ENGINE READS ─────────────────
  //
  // This block used to derive every figure on the cap card from
  // `agents.cap_progress` and `agents.cap_amount`. Both were wrong in a way that
  // is worth stating, because the card looked plausible either way:
  //
  //  · `cap_progress` measured THE WRONG SIDE OF THE SPLIT. Its only writer
  //    computed `ytd_gci / cap_amount * 100`, and `ytd_gci` is what the AGENT
  //    KEPT — but a cap is a ceiling on what the BROKERAGE COLLECTS
  //    (lib/commission/waterfall/07-apply-cap.ts: "Cap tracks brokerage's
  //    cumulative earnings, NOT agent's"). On a 70/30 an agent read as capped
  //    when the brokerage had taken roughly 43% of the cap.
  //  · `totalCapRevenue` then multiplied that percentage back out into dollars,
  //    so "Cap Revenue" — a number a broker reads as money collected — was a
  //    reconstruction of a figure that measured the other party's earnings.
  //
  // MEASURED before this change: of four agents carrying `agents.cap_amount`,
  // THREE had no ledger row at all, so the engine never capped them. The screen
  // showed caps that had never been applied to a cheque.
  //
  // Now every figure comes from `agent_cap_tracking` for the window containing
  // today — stage 07's own filter — so this card and the payout agree by
  // construction. `cap_paid_to_date` is already dollars the brokerage collected;
  // nothing is reconstructed.
  const todayIso = new Date().toISOString().slice(0, 10)
  const { data: capRows, error: capRowsError } = await supabase
    .from("agent_cap_tracking")
    .select("agent_id, cap_amount, cap_paid_to_date, is_capped")
    .eq("brokerage_id", profile.brokerage_id)
    .lte("anniversary_start", todayIso)
    .gte("anniversary_end", todayIso)

  const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  // A refused read is not "nobody is capped". Reported rather than rendered as
  // a confident zero — the whole defect this replaces was a confident number.
  const capLedgerUnavailable = !!capRowsError
  const capByAgent = new Map<string, { amount: number; paid: number; capped: boolean }>()
  for (const r of (capRows ?? []) as Array<{ agent_id: string; cap_amount: unknown; cap_paid_to_date: unknown; is_capped: unknown }>) {
    // agent_cap_tracking has no uniqueness on (agent, window); if two rows
    // overlap, the one further along is the one the money is actually against.
    const prev = capByAgent.get(r.agent_id)
    const next = { amount: num(r.cap_amount), paid: num(r.cap_paid_to_date), capped: r.is_capped === true }
    if (!prev || next.paid > prev.paid) capByAgent.set(r.agent_id, next)
  }

  const cappedAgents = agents.filter(a => {
    const c = capByAgent.get(a.id)
    return !!c && (c.capped || c.paid >= c.amount)
  })

  const capSummary = {
    // Has a cap and has not reached it.
    belowCap: agents.filter(a => {
      const c = capByAgent.get(a.id)
      return !!c && !(c.capped || c.paid >= c.amount)
    }).length,
    // Has reached it: the brokerage's share is now $0 and the agent is on 100%.
    atCap: cappedAgents.length,
    // NO cap configured at all — uncapped for ever, which is the real revenue
    // exposure the old "Post-Cap" card was gesturing at with a percentage band
    // (`>= 101`) that a value clamped to 100 could never enter, so it always
    // read zero.
    uncapped: agents.filter(a => !capByAgent.has(a.id)).length,
    recentlyCapped: cappedAgents,
    totalAgents: agents.length,
    capLedgerUnavailable,
    // Dollars the brokerage has actually collected toward caps, straight off the
    // ledger. Clamped at the cap because collection stops there.
    totalCapRevenue: agents.reduce((sum, a) => {
      const c = capByAgent.get(a.id)
      return c ? sum + Math.min(c.paid, c.amount) : sum
    }, 0),
    totalCapPotential: agents.reduce((sum, a) => sum + (capByAgent.get(a.id)?.amount ?? 0), 0),
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

  // Build broker financial priority
  const brokerPriority: FinancialPriority | null = (() => {
    const profitMargin = latestPL?.profit_margin_pct || 0
    const pendingPayouts = capSummary.belowCap
    
    if (profitMargin < 10 && (mtdEarnings?.gross_commission_income || 0) > 0) {
      return {
        id: "low-margin",
        title: "Profit Margin Under Pressure",
        description: "Operating expenses are compressing net income",
        urgency: "high",
        metric: `${profitMargin.toFixed(1)}%`,
        metricLabel: "margin",
        ctaLabel: "Review Expenses",
        ctaHref: "/dashboard/financials/expenses",
      }
    }
    
    // This priority could NEVER FIRE before. It tested `postCap`, defined as
    // `cap_progress >= 101` — and cap_progress was written as
    // `Math.min(…, 100)`, clamped, so no agent could ever exceed 100 and the
    // count was structurally zero. The exposure it was written to catch is real,
    // so it is now asked of the ledger: agents who have HIT their cap are on
    // 100% commission from here to their anniversary.
    if (capSummary.atCap > capSummary.totalAgents * 0.3) {
      return {
        id: "cap-exposure",
        title: "High Post-Cap Agent Ratio",
        description: `${capSummary.atCap} agents have hit their cap and are on 100% commission - revenue exposure`,
        urgency: "medium",
        metric: `${capSummary.atCap}`,
        metricLabel: "post-cap agents",
        ctaLabel: "Review Caps",
        ctaHref: "/dashboard/financials/payouts",
      }
    }
    
    return null
  })()

  // Build broker action stack
  const brokerActions: FinancialAction[] = [
    {
      id: "review-payouts",
      title: "Review Agent Payouts",
      description: `${capSummary.totalAgents} active agents with pending payouts`,
      priority: "medium",
      type: "payout",
      href: "/dashboard/financials/payouts",
    },
    {
      id: "view-team-revenue",
      title: "View Team Revenue",
      description: "Breakdown by team performance",
      priority: "low",
      type: "review",
      href: "/dashboard/financials/team",
    },
    {
      id: "generate-pl",
      title: "Generate P&L Report",
      description: "Comprehensive brokerage financial analysis",
      priority: "low",
      type: "report",
    },
  ]
  
  if ((latestPL?.profit_margin_pct || 0) < 15) {
    brokerActions.unshift({
      id: "margin-review",
      title: "Address Margin Compression",
      description: "Profit margin below healthy threshold",
      priority: "high",
      type: "budget",
    })
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

      {/* Financial Command Strip */}
      <FinancialCommandStrip
        priority={brokerPriority}
        periodSummary={{
          mtdRevenue: mtdEarnings?.brokerage_net || 0,
          ytdRevenue: ytdEarnings?.brokerage_net || 0,
          pendingCommissions: 0,
          expensesMTD: (latestPL?.operating_expenses || 0) + (latestPL?.tech_expenses || 0),
        }}
        role="broker"
      />

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

      {/* ─��─ SECTION 3: PER-TEAM REVENUE TABLE ────────────────────────────────── */}
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

      {/* ─── SECTION 4: AGENT CAPS SUMMARY ───────────��────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Agent Caps Summary
          </CardTitle>
          <CardDescription>
            {capSummary.capLedgerUnavailable
              ? "The cap ledger could not be read — the figures below are not a statement that nobody is capped."
              : "Cap status distribution and revenue impact, from agent_cap_tracking — the ledger the payout engine applies"}
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
            {/*
              Was "Post-Cap", counting cap_progress >= 101 — impossible, because
              the writer clamped that value to 100. It read 0 for every brokerage
              for its whole life. The genuinely distinct third state, which
              nothing surfaced before, is an agent with NO cap configured: they
              never stop earning the brokerage its full split, and equally the
              brokerage has never agreed a ceiling with them.
            */}
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 text-green-600" />
                <span className="text-sm text-green-800">No Cap Set</span>
              </div>
              <p className="text-2xl font-bold mt-1">{capSummary.uncapped}</p>
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
              <ForecastChart data={forecasts.map((f: any) => ({
                forecast_month: f.period_label ?? f.forecast_month ?? "",
                projected_revenue: f.gross_commission_income ?? f.projected_revenue ?? 0,
                actual_revenue: f.brokerage_net ?? f.actual_revenue ?? null,
              }))} />
            </Suspense>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Forecast will appear once 3 months of data is available
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── SECTION 7: MARGIN BREAKDOWN & ACTION STACK ────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <MarginBreakdownPanel
          grossIncome={mtdEarnings?.gross_commission_income || 0}
          breakdown={[
            {
              label: "Agent Splits",
              value: latestPL?.agent_splits_paid || 0,
              percentOfGross: (mtdEarnings?.gross_commission_income || 0) > 0
                ? ((latestPL?.agent_splits_paid || 0) / (mtdEarnings?.gross_commission_income || 1)) * 100
                : 0,
            },
            {
              label: "Operating Expenses",
              value: latestPL?.operating_expenses || 0,
              percentOfGross: (mtdEarnings?.gross_commission_income || 0) > 0
                ? ((latestPL?.operating_expenses || 0) / (mtdEarnings?.gross_commission_income || 1)) * 100
                : 0,
            },
            {
              label: "Technology",
              value: latestPL?.tech_expenses || 0,
              percentOfGross: (mtdEarnings?.gross_commission_income || 0) > 0
                ? ((latestPL?.tech_expenses || 0) / (mtdEarnings?.gross_commission_income || 1)) * 100
                : 0,
            },
            {
              label: "Marketing",
              value: latestPL?.marketing_expenses || 0,
              percentOfGross: (mtdEarnings?.gross_commission_income || 0) > 0
                ? ((latestPL?.marketing_expenses || 0) / (mtdEarnings?.gross_commission_income || 1)) * 100
                : 0,
            },
          ]}
          netMargin={latestPL?.profit_margin_pct || 0}
        />
        
        <FinancialActionStack actions={brokerActions} />
      </div>

      {/* ─── SECTION 7.5: SCOPED EXPENSE ENTRY (brokerage / team / agent) ─────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ScopedExpenseEntry
          teams={(teamOptions ?? []).map((t) => ({ id: t.id as string, name: (t.name as string) ?? "Team" }))}
          canLogAgentScope={Boolean(brokerAgentId)}
        />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PieChart className="w-5 h-5 text-orange-600" />
              Recent Operating Expenses
            </CardTitle>
            <CardDescription>Brokerage + team scoped (agent expenses live on each agent&apos;s book)</CardDescription>
          </CardHeader>
          <CardContent>
            {(recentOpExpenses ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No brokerage or team expenses logged yet — the P&amp;L expense lines stay empty until the first entry.</p>
            ) : (
              <div className="space-y-2">
                {(recentOpExpenses ?? []).map((e: any) => (
                  <div key={e.id} className="flex items-center justify-between border-b last:border-0 pb-2 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-sm truncate">{e.description || "Expense"}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(e.expense_date).toLocaleDateString()} · <Badge variant="outline" className="text-[10px]">{e.category || "other"}</Badge> · {e.team_id ? "Team" : "Brokerage"}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-orange-600 shrink-0 ml-3">{formatCurrency(e.amount)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── SECTION 8: P&L REPORT GENERATOR ──────────────────────────────────── */}
      {/* pass 12: the panel's report reads business_expenses.agent_id and inserts
          financial_reports.agent_id — both agents.id FKs. profile.id is users.id,
          which read empty and FK-failed the insert. Resolve the broker's agents
          row; brokers without one get the brokerage-wide truth section below. */}
      {brokerAgentId && <ProfitLossReportPanel agentId={brokerAgentId} />}

      {/* ─── SECTION 9: AGENT P&L TRUTH ENGINE ────────────────────────────────── */}
      {/* Per-agent net ROI: GCI – agent_payout – AI costs – fees = true brokerage margin */}
      {/* ─── SECTION 8: RECRUITING & REFERRAL ECONOMICS ────────────────────────
          KEEP-ONE. /dashboard/admin/brokerage-pnl rendered a second "Brokerage P&L"
          — same nav label, same owner audience, a fraction of the depth (134 lines
          against this page's 1,421). It was removed, but NOT before porting the two
          things it had that this page did not: recruiting ROI and referral value.
          A grep for recruit|referral across this directory previously returned
          nothing, so deleting the smaller page without this section would have lost
          the owner's whole recruiting-economics view. Same generateBrokeragePnl
          source, so the numbers agree with what that page showed. */}
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <RecruitingAndReferralEconomics brokerageId={profile.brokerage_id} />
      </Suspense>

      {/* ─── SECTION 9: COMPANY-BOOKS OBLIGATIONS (m577) ──────────────────────
          The READ half of the post-cap company-books ledger. Waterfall stage 11
          writes an obligation here when a brokerage-funded share (revenue share,
          team split) lands on a deal whose company dollar cannot fund it — post-
          cap the brokerage's in-deal final is $0 (owner ruling 2026-08-28: the
          cap ends the brokerage TAKING, not the brokerage PAYING). These are
          payables from the company's own books, deliberately OUTSIDE the deal's
          distribution set, so the deal's disbursement sweeps never mark them
          paid — which is exactly why they need their own surface: an unread
          payables ledger is a bill nobody knows they owe. */}
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <CompanyBooksObligations brokerageId={profile.brokerage_id} />
      </Suspense>

      <AgentPLTruthSection brokerageId={profile.brokerage_id} />
    </div>
  )
}

/**
 * Recruiting + referral economics — the owner's two questions this P&L could not
 * answer: did recruiting pay for itself, and what are referral partners worth.
 */
async function RecruitingAndReferralEconomics({ brokerageId }: { brokerageId: string }) {
  const pnl = await generateBrokeragePnl({ brokerageId })
  const usd = (n: number | null | undefined) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
      .format(Number(n ?? 0))

  return (
    <div className="space-y-6">
    {/* BY OFFICE — rendered only for a brokerage that HAS offices. generateBrokeragePnl
        returns an empty array for a single-office brokerage rather than one row
        restating the brokerage total, so this whole card disappears instead of
        showing a breakdown that breaks nothing down. The office comes from
        agents.location_id joined through the producing agent — see the
        OfficeProduction doc comment for why it is derived rather than stored,
        and what that costs when an agent transfers offices. */}
    {pnl.byOffice.length > 0 && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Production by office
          </CardTitle>
          <CardDescription>
            Company dollar and payouts per office. Offices are set in Admin → Office Locations;
            an agent with no office lands in “No office assigned” so the parts still sum to the total.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Office</th>
                  <th className="px-4 py-2 font-medium text-right">Agents</th>
                  <th className="px-4 py-2 font-medium text-right">Closings</th>
                  <th className="px-4 py-2 font-medium text-right">GCI</th>
                  <th className="px-4 py-2 font-medium text-right">Company dollar</th>
                  <th className="px-4 py-2 font-medium text-right">Agent payouts</th>
                </tr>
              </thead>
              <tbody>
                {pnl.byOffice.map((o) => (
                  <tr key={o.locationId ?? "unassigned"} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      {o.name}
                      {o.locationId === null && (
                        <span className="ml-2 text-xs text-amber-700">needs assignment</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{o.agentCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{o.closings}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{usd(o.gci)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{usd(o.brokerageNet)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{usd(o.agentPayouts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    )}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Recruiting economics
          </CardTitle>
          <CardDescription>Did recruiting pay for itself</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Recruited agents</span><span className="font-medium">{pnl.recruiting.recruitedAgentCount}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Total recruiting cost</span><span className="font-medium">{usd(pnl.recruiting.totalRecruitingCost)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Lifetime brokerage net</span><span className="font-medium">{usd(pnl.recruiting.lifetimeBrokerageNet)}</span></div>
          <div className="flex justify-between border-t pt-1 mt-1">
            <span className="text-muted-foreground">Blended ROI</span>
            <span className={"font-semibold " + ((pnl.recruiting.blendedRoiPct ?? 0) >= 0 ? "text-green-700" : "text-red-700")}>
              {pnl.recruiting.blendedRoiPct === null ? "—" : `${pnl.recruiting.blendedRoiPct}%`}
            </span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Handshake className="h-5 w-5" /> Referral economics
          </CardTitle>
          <CardDescription>What partner relationships are worth</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Active partners</span><span className="font-medium">{pnl.referrals.activePartners}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Partner value generated</span><span className="font-medium">{usd(pnl.referrals.partnerValueGenerated)}</span></div>
          <p className="text-xs text-muted-foreground pt-2">Credited automatically by the referral closing loop as deals close.</p>
        </CardContent>
      </Card>
    </div>
    </div>
  )
}

async function AgentPLTruthSection({ brokerageId }: { brokerageId: string }) {
  const result = await getAgentPLSummary()
  if (!result.ok) return null
  return (
    <div className="space-y-2">
      <AgentPLTable rows={result.rows} monthYear={result.monthYear} />
    </div>
  )
}

/**
 * Company-books obligations — the reader of every column stage 11 writes.
 * Cookie client on purpose: m577's tenant RLS applies to the read itself, so a
 * cross-tenant row cannot render even if a predicate were wrong. A refused read
 * is reported, never rendered as a confidently empty ledger (§4).
 */
async function CompanyBooksObligations({ brokerageId }: { brokerageId: string }) {
  const supabase = await createClient()
  const { data: rows, error } = await supabase
    .from("company_books_obligations")
    .select("id, agent_id, obligation_type, calculation_type, calculation_value, calculated_amount, reason, cap_status, status, calculation_version, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(100)

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Company-books obligations</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">
            The obligations ledger could not be read: {error.message}. Nothing here means “unreadable”, not “nothing owed”.
          </p>
        </CardContent>
      </Card>
    )
  }
  const obligations = rows ?? []
  if (obligations.length === 0) return null

  // Recipient names — agents.id keys the ledger; resolve display names once.
  const agentIds = Array.from(new Set(obligations.map((o) => o.agent_id).filter(Boolean)))
  const { data: agentRows } = await supabase
    .from("agents").select("id, first_name, last_name").in("id", agentIds).limit(200)
  const nameOf = new Map((agentRows ?? []).map((a: any) => [a.id, `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim()]))

  const usd = (n: number | null | undefined) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(n ?? 0))
  const pendingTotal = obligations.filter((o) => o.status === "pending").reduce((s, o) => s + Number(o.calculated_amount ?? 0), 0)
  // §6 vocabulary rendered, not restated: 'residual' is the revenue-share word,
  // 'team_member' the brokerage-funded team split; 'post_cap_company_books' is
  // the only reason stage 11 writes today.
  const kindLabel = (t: string | null) => (t === "residual" ? "Revenue share" : t === "team_member" ? "Team member share" : t ?? "—")
  const reasonLabel = (r: string | null) => (r === "post_cap_company_books" ? "post-cap — company books" : r ?? "—")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Handshake className="h-5 w-5" /> Company-books obligations
        </CardTitle>
        <CardDescription>
          Brokerage-funded shares that landed on capped deals — the cap ended the taking, not the paying.
          These are owed from company books, not from any deal&apos;s disbursement. Pending: {usd(pendingTotal)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Owed to</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium text-right">Amount</th>
                <th className="px-4 py-2 font-medium">Basis</th>
                <th className="px-4 py-2 font-medium">Why on company books</th>
                <th className="px-4 py-2 font-medium">Deal cap state</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {obligations.map((o) => (
                <tr key={o.id} className="border-b last:border-0">
                  <td className="px-4 py-2">{nameOf.get(o.agent_id) || "Unknown agent"}</td>
                  <td className="px-4 py-2">{kindLabel(o.obligation_type)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">{usd(o.calculated_amount)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {o.calculation_type === "percent" && o.calculation_value != null
                      ? `${o.calculation_value}%`
                      : o.calculation_type === "flat"
                        ? "flat"
                        : o.calculation_type ?? "—"}
                    {o.calculation_version != null && <span className="ml-1">· engine v{o.calculation_version}</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{reasonLabel(o.reason)}</td>
                  <td className="px-4 py-2">
                    {o.cap_status ? <Badge variant="outline" className="text-[11px]">{o.cap_status}</Badge> : "—"}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={o.status === "paid" ? "default" : "outline"} className="text-[11px] capitalize">{o.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
