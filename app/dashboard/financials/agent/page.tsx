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

  const { agentId, brokerageId } = context
  const currentYear = new Date().getFullYear()

  // Parallel fetch all financial data
  const [
    agentData,
    mtdEarnings,
    ytdEarnings,
    earningsHistory,
    businessExpenses,
    pendingCommissions,
    teamSplits,
    bonusCredits,
    monthlyTrend,
    ytdTransactionCount,
  ] = await Promise.all([
    // Agent profile for cap info
    supabase
      .from("agents")
      .select("id, first_name, last_name, cap_amount, cap_progress, gamification_points")
      .eq("id", agentId)
      .single()
      .then((r) => r.data),

    // MTD earnings from agent_earnings
    supabase
      .from("agent_earnings")
      .select("*")
      .eq("agent_id", agentId)
      .eq("period_type", "mtd")
      .order("computed_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data),

    // YTD earnings from agent_earnings
    supabase
      .from("agent_earnings")
      .select("*")
      .eq("agent_id", agentId)
      .eq("period_type", "ytd")
      .order("computed_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data),

    // Earnings history for breakdown table
    supabase
      .from("earnings_history")
      .select(`
        id,
        transaction_id,
        paid_date,
        gross_commission,
        agent_net,
        brokerage_net,
        total_fees,
        transactions:transaction_id(property_address)
      `)
      .eq("agent_id", agentId)
      .order("paid_date", { ascending: false })
      .limit(100)
      .then((r) => r.data || []),

    // Business expenses grouped by category
    supabase
      .from("business_expenses")
      .select("id, category, amount, description, expense_date")
      .eq("agent_id", agentId)
      .order("expense_date", { ascending: false })
      .then((r) => r.data || []),

    // Pending/pipeline commissions
    supabase
      .from("commission_calculations")
      .select(`
        id,
        transaction_id,
        total_commission,
        calculated_at,
        transactions:transaction_id(property_address, status, stage)
      `)
      .eq("agent_id", agentId)
      .order("calculated_at", { ascending: false })
      .then((r) => r.data || []),

    // Team splits (commission_distributions where this agent received team split)
    supabase
      .from("commission_distributions")
      .select(`
        id,
        calculated_amount,
        distribution_type,
        transaction_id,
        transactions:transaction_id(property_address)
      `)
      .eq("agent_id", agentId)
      .eq("distribution_type", "team_split")
      .then((r) => r.data || []),

    // Bonus credits from commission_adjustments
    supabase
      .from("commission_adjustments")
      .select("amount")
      .eq("applies_to", agentId)
      .eq("adjustment_type", "credit")
      .eq("is_active", true)
      .then((r) => {
        const adjustments = r.data || []
        return adjustments.reduce((sum, adj) => sum + (adj.amount || 0), 0)
      }),

    // Monthly trend for last 12 months
    supabase
      .from("earnings_history")
      .select("paid_date, gross_commission, agent_net")
      .eq("agent_id", agentId)
      .gte("paid_date", new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0])
      .order("paid_date", { ascending: true })
      .then((r) => r.data || []),

    // YTD transaction count
    supabase
      .from("commissions")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .gte("paid_date", `${currentYear}-01-01`)
      .then((r) => r.count || 0),
  ])

  // Process earnings history to include property address
  const processedEarningsHistory = earningsHistory.map((record: any) => ({
    ...record,
    property_address: record.transactions?.property_address,
  }))

  // Calculate expense totals by category
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

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Earnings</h1>
        <p className="text-muted-foreground mt-1">
          Track your commissions, cap progress, and financial performance
        </p>
      </div>

      {/* Section 1: KPI Row */}
      <EarningsKPIRow
        mtdAgentNet={mtdEarnings?.agent_net || 0}
        ytdAgentNet={ytdEarnings?.agent_net || 0}
        ytdGrossCommission={ytdEarnings?.gross_commission || 0}
        ytdTransactionCount={ytdTransactionCount}
      />

      {/* Section 2: Cap Progress */}
      <CapProgressBar
        capAmount={agentData?.cap_amount || null}
        capProgress={agentData?.cap_progress || 0}
        capProgressPct={ytdEarnings?.cap_progress_pct || 0}
        bonusCredits={bonusCredits}
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
                    <div>
                      <p className="font-medium text-sm">
                        {deal.transactions?.property_address || "Pending Deal"}
                      </p>
                      <Badge variant="secondary" className="text-xs mt-1">
                        {deal.transactions?.stage || "In Progress"}
                      </Badge>
                    </div>
                    <p className="font-semibold text-amber-600">
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
    </div>
  )
}

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
