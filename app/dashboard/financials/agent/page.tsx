import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EarningsKPIRow } from "@/app/components/financials/EarningsKPIRow"
import { CapProgressBar } from "@/app/components/financials/CapProgressBar"
import { CommissionBreakdownTable } from "@/app/components/financials/CommissionBreakdownTable"
import { 
  DollarSign, 
  PieChart, 
  TrendingUp, 
  Users, 
  AlertCircle,
  BarChart3,
  Briefcase
} from "lucide-react"
import { ExpensesDonutChart } from "./expenses-chart"
import { EarningsTrendChart } from "./earnings-trend-chart"
import {
  FinancialCommandStrip,
  ProfitabilityRadar,
  FinancialActionStack,
  ProfitLossReportPanel,
  type FinancialPriority,
  type FinancialAction,
} from "../components/os"
import { getProviderConnectionStatus } from "@/app/actions/accounting-sync"
import { AgentFinancialsClient } from "./agent-financials-client"
import { loadAgentFinancialDashboardSummaryAction } from "@/app/actions/financial-kernel"

export const dynamic = "force-dynamic"

export default async function AgentFinancialsPage() {
  const supabase = await createClient()

  // Get agent context with identity resolution
  let context
  try {
    context = await getAgentContext()
  } catch {
    redirect("/login")
  }

  const { agentId: agentIdRaw, brokerageId: brokerageIdRaw } = context
  const agentId = agentIdRaw!
  const brokerageId = brokerageIdRaw!
  const currentYear = new Date().getFullYear()

  // Load agent financial summary via kernel command (replaces 16 individual DB queries)
const financialSummaryResult = await loadAgentFinancialDashboardSummaryAction({
  agentId,
  brokerageId,
})

  if (!financialSummaryResult.success) {
    redirect("/login")
  }

  const summary = financialSummaryResult.data!

  // Fetch accounting sync status in parallel (not in kernel scope yet)
  const syncStatus = await getProviderConnectionStatus(brokerageId!).catch(() => null)

  // Extract data from kernel result
  const mtdEarnings = summary.mtdEarnings ?? 0
  const ytdEarnings = summary.ytdEarnings ?? 0
  const businessExpenses = summary.expenses ?? []
  const pendingCommissions = summary.pendingCommissions ?? []
  const teamSplits = summary.teamSplits ?? []
  const bonusCredits = summary.bonusCredits ?? []
  const monthlyTrend = summary.monthlyTrendData ?? []
  const ytdTransactionCount = summary.ytdTransactionCount ?? 0
  const commissionProfile = summary.commissionProfile ?? null
  const capTrackingRaw = summary.capTracking ?? null
  const capTracking = capTrackingRaw ? {
    cap_amount: capTrackingRaw.capAmount,
    cap_paid_to_date: capTrackingRaw.capPaidToDate,
    is_capped: capTrackingRaw.capIsCapped,
    anniversary_start: capTrackingRaw.anniversaryStart,
    anniversary_end: capTrackingRaw.anniversaryEnd,
  } : null
  const agentData = summary.agentData ?? null
  const pipelineTransactions = summary.pipelineTransactions ?? []
  const earningsHistory = summary.earningsHistory ?? []

  // Additional derived data
  const currentBilling = null
  const existingBudget = null
  const processedEarningsHistory = earningsHistory ?? []

  // Helper function to process monthly trend data
  function processMonthlyTrend(data: any[]) {
    const monthlyMap = new Map<string, { gross: number; net: number }>()

    data.forEach((record) => {
      const date = new Date(record.paid_date)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
      
      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, { gross: 0, net: 0 })
      }
      
      const current = monthlyMap.get(monthKey)!
      current.gross += record.gross_commission || 0
      current.net += record.agent_net || 0
    })

    // Get last 12 months
    const result = []
    const now = new Date()
    
    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
      const monthLabel = date.toLocaleDateString("en-US", { month: "short" })
      
      const values = monthlyMap.get(monthKey) || { gross: 0, net: 0 }
      result.push({
        month: monthLabel,
        gross: values.gross,
        net: values.net,
      })
    }
    
    return result
  }

  // Calculate expense totals by category (same logic as before)
  const expensesByCategory = businessExpenses.reduce((acc: Record<string, number>, expense: any) => {
    const category = expense.category || "Other"
    acc[category] = (acc[category] || 0) + (expense.amount || 0)
    return acc
  }, {})

  const totalExpensesMTD = businessExpenses
    .filter((e: any) => {
      const expenseDate = new Date(e.expense_date)
      const now = new Date()
      return expenseDate.getMonth() === now.getMonth() && expenseDate.getFullYear() === now.getFullYear()
    })
    .reduce((sum: number, e: any) => sum + (e.amount || 0), 0)

  const totalExpensesYTD = businessExpenses
    .filter((e: any) => new Date(e.expense_date).getFullYear() === currentYear)
    .reduce((sum: number, e: any) => sum + (e.amount || 0), 0)

  // Filter pending pipeline (not yet paid)
  const pipelineDeals = pendingCommissions.filter(
    (c: any) => c.transactions?.status === "active" || c.transactions?.status === "pending"
  )
  const totalPipelineValue = pipelineDeals.reduce((sum: number, c: any) => sum + (c.total_commission || 0), 0)

  // Team split totals
  const totalTeamSplitsPaid = teamSplits.reduce((sum: number, s: any) => sum + (s.calculated_amount || 0), 0)

  // Process monthly trend data
  const monthlyTrendData = processMonthlyTrend(monthlyTrend)

  // Calculate net income after expenses
  const ytdNetAfterExpenses = (ytdEarnings?.agent_net || 0) - totalExpensesYTD

  // Build financial priority
  const financialPriority: FinancialPriority | null = (() => {
    const pendingAmount = totalPipelineValue
    const pendingCount = pipelineDeals.length
    
    if (pendingCount > 3 && pendingAmount > 50000) {
      return {
        id: "pending-commissions",
        title: "Multiple Pending Commissions",
        description: `${pendingCount} deals worth ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pendingAmount)} in pipeline`,
        urgency: "high",
        metric: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pendingAmount),
        metricLabel: "pending",
        ctaLabel: "Review Pipeline",
        ctaHref: "/dashboard/financials/commissions",
      }
    }
    
    if (totalExpensesMTD > (mtdEarnings?.agent_net || 0) * 0.5 && totalExpensesMTD > 1000) {
      return {
        id: "expense-pressure",
        title: "Expense Pressure This Month",
        description: "Expenses are running high relative to income",
        urgency: "medium",
        metric: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalExpensesMTD),
        metricLabel: "MTD expenses",
        ctaLabel: "Track Expenses",
        ctaHref: "/dashboard/financials/expenses",
      }
    }
    
    return null
  })()

  // Build action stack
  const financialActions: FinancialAction[] = []
  
  if (pipelineDeals.length > 0) {
    financialActions.push({
      id: "review-pending",
      title: "Review Pending Commissions",
      description: `${pipelineDeals.length} commission${pipelineDeals.length !== 1 ? "s" : ""} awaiting close`,
      priority: pipelineDeals.length > 3 ? "high" : "medium",
      type: "commission",
      value: totalPipelineValue,
      href: "/dashboard/financials/commissions",
    })
  }
  
  financialActions.push({
    id: "log-expense",
    title: "Log New Expense",
    description: "Track business expenses for tax deductions",
    priority: "low",
    type: "expense",
    href: "/dashboard/financials/expenses",
  })
  
  financialActions.push({
    id: "generate-pl",
    title: "Generate P&L Report",
    description: "AI-powered profit and loss analysis",
    priority: "low",
    type: "report",
  })

  // Format expenses for planning components
  const formattedExpenses = businessExpenses.map((e: any) => ({
    id: e.id,
    category: e.category || "Uncategorized",
    amount: e.amount || 0,
    description: e.description || "",
    receipt_url: e.receipt_url,
    date: e.expense_date,
  }))

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Earnings</h1>
        <p className="text-muted-foreground mt-1">
          Track your commissions, cap progress, and financial performance
        </p>
      </div>

      <AgentFinancialsClient
        agentId={agentId}
        brokerageId={brokerageId}
        ytdGCI={ytdEarnings?.gross_commission || 0}
        ytdExpenses={totalExpensesYTD}
        ytdTransactionCount={ytdTransactionCount}
        expenses={formattedExpenses}
        syncStatus={syncStatus as any}
        currentBilling={currentBilling ?? null}
        existingBudget={existingBudget ?? null}
        pipelineTransactions={(pipelineTransactions as any[]) ?? []}
        commissionProfile={commissionProfile ?? null}
        capTracking={capTracking ?? null}
      >
        {/* Financial Command Strip */}
        <FinancialCommandStrip
        priority={financialPriority}
        periodSummary={{
          mtdRevenue: mtdEarnings?.agent_net || 0,
          ytdRevenue: ytdEarnings?.agent_net || 0,
          pendingCommissions: totalPipelineValue,
          expensesMTD: totalExpensesMTD,
        }}
        role="agent"
      />

      {/* Section 1: KPI Row */}
      <EarningsKPIRow
        mtdAgentNet={mtdEarnings?.agent_net || 0}
        ytdAgentNet={ytdEarnings?.agent_net || 0}
        ytdGrossCommission={ytdEarnings?.gross_commission || 0}
        ytdTransactionCount={ytdTransactionCount}
      />

      {/* Section 2: Cap Progress — prefers agent_cap_tracking, falls back to agents table */}
      <CapProgressBar
        capAmount={capTracking?.cap_amount ?? agentData?.cap_amount ?? null}
        capProgress={capTracking?.cap_paid_to_date ?? agentData?.cap_progress ?? 0}
        capProgressPct={capTrackingRaw?.capProgressPct || 0}
        bonusCredits={bonusCredits.reduce((sum: number, b: any) => sum + (b.amount || b.credit_amount || 0), 0)}
        isCapped={capTracking?.is_capped ?? false}
        anniversaryStart={capTracking?.anniversary_start ?? undefined}
        anniversaryEnd={capTracking?.anniversary_end ?? undefined}
      />

      {/* Section 3: Commission Breakdown Table */}
      <CommissionBreakdownTable earningsHistory={processedEarningsHistory} />

      {/* Section 4 & 5: Two column layout */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Section 4: Business Expenses Breakdown */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <PieChart className="h-5 w-5 text-purple-600" />
              <div>
                <CardTitle>Business Expenses</CardTitle>
                <CardDescription>Expense breakdown by category</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {Object.keys(expensesByCategory).length > 0 ? (
              <div className="space-y-4">
                <ExpensesDonutChart data={expensesByCategory} />
                <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                  <div className="text-center">
                    <p className="text-lg font-semibold text-purple-600">
                      ${totalExpensesMTD.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">MTD Expenses</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-semibold text-purple-600">
                      ${totalExpensesYTD.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">YTD Expenses</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <PieChart className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No expenses recorded yet</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 5: Pipeline Earnings */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Briefcase className="h-5 w-5 text-amber-600" />
                <div>
                  <CardTitle>Pipeline Earnings</CardTitle>
                  <CardDescription>Projected — not yet paid</CardDescription>
                </div>
              </div>
              <Badge variant="outline" className="bg-amber-50 text-amber-700">
                Projected
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {pipelineDeals.length > 0 ? (
              <div className="space-y-3">
                {pipelineDeals.slice(0, 5).map((deal: any) => (
                  <div
                    key={deal.id}
                    className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {deal.transactions?.property_address || "Pending Deal"}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="secondary" className="text-xs">
                          {deal.transactions?.stage || "In Progress"}
                        </Badge>
                        <a
                          href={`/dashboard/transactions/${deal.transaction_id}#deposits`}
                          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          View Deposits
                        </a>
                      </div>
                    </div>
                    <p className="font-semibold text-amber-600 ml-3 shrink-0">
                      ${deal.total_commission?.toLocaleString() || 0}
                    </p>
                  </div>
                ))}
                <div className="pt-3 border-t">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">Total Pipeline Value</p>
                    <p className="text-xl font-bold text-amber-600">
                      ${totalPipelineValue.toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Briefcase className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No pending deals in pipeline</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Section 6: Team Split Detail */}
      {teamSplits.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-blue-600" />
              <div>
                <CardTitle>Team Split Detail</CardTitle>
                <CardDescription>Revenue shared with team</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {teamSplits.slice(0, 5).map((split: any) => (
                <div
                  key={split.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <p className="text-sm">
                    {split.transactions?.property_address || "Transaction"}
                  </p>
                  <p className="font-medium text-blue-600">
                    ${split.calculated_amount?.toLocaleString() || 0}
                  </p>
                </div>
              ))}
              <div className="pt-3 border-t">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">Total Team Splits Paid</p>
                  <p className="text-lg font-bold text-blue-600">
                    ${totalTeamSplitsPaid.toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Section 7: 12-Month Trend Chart */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-green-600" />
            <div>
              <CardTitle>12-Month Earnings Trend</CardTitle>
              <CardDescription>Monthly agent net and gross commission</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {monthlyTrendData.length > 0 ? (
            <EarningsTrendChart data={monthlyTrendData} />
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No earnings data for trend analysis yet</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 8: OS Components - Profitability Radar & Action Stack */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfitabilityRadar
          metrics={{
            grossIncome: ytdEarnings?.gross_commission || 0,
            netProfit: ytdNetAfterExpenses,
            profitMargin: (ytdEarnings?.gross_commission || 0) > 0 
              ? (ytdNetAfterExpenses / (ytdEarnings?.gross_commission || 1)) * 100 
              : 0,
            expenseRatio: (ytdEarnings?.agent_net || 0) > 0 
              ? (totalExpensesYTD / (ytdEarnings?.agent_net || 1)) * 100 
              : 0,
            // cap_progress on agents table is a 0-100 percentage value
            targetProgress: agentData?.cap_amount 
              ? Math.min((agentData?.cap_progress || 0), 100)
              : capTracking?.cap_amount
                ? Math.min(((capTracking.cap_paid_to_date ?? 0) / capTracking.cap_amount) * 100, 100)
                : undefined,
          }}
          period="ytd"
        />
        
        <FinancialActionStack actions={financialActions} />
      </div>

        {/* Section 9: P&L Report Generator */}
        <ProfitLossReportPanel agentId={agentId} />
      </AgentFinancialsClient>
    </div>
  )
}
