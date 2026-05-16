"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { generateTextRouted } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"

// ─── AI FORECAST ─────────────────────────────────────────────────────────────

export async function generateAIForecast(params: {
  agentId: string
  brokerageId: string
  ytdGCI: number
  ytdTransactionCount: number
  pipelineValue: number
  monthsElapsed: number
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  try {
    // Fetch last 3 years of earnings for trend analysis
    const { data: history } = await supabase
      .from("earnings_history")
      .select("paid_date, gross_commission, agent_net")
      .eq("agent_id", params.agentId)
      .order("paid_date", { ascending: false })
      .limit(36)

    const avgMonthlyGCI =
      params.monthsElapsed > 0 ? params.ytdGCI / params.monthsElapsed : 0
    const projectedYTD = avgMonthlyGCI * 12

    const historySummary =
      history && history.length > 0
        ? history
            .slice(0, 12)
            .map((h: any) => `${h.paid_date}: $${(h.gross_commission || 0).toLocaleString()}`)
            .join(", ")
        : "No historical data available"

    const { text } = await generateTextRouted({
      feature: "unspecified",
      messages: [
        {
          role: "user",
          content: `You are a real estate financial advisor. Based on this agent's current YTD performance, provide a concise earnings forecast for the rest of the year.

YTD GCI: $${params.ytdGCI.toLocaleString()}
Closed transactions: ${params.ytdTransactionCount}
Active pipeline value: $${params.pipelineValue.toLocaleString()}
Months elapsed: ${params.monthsElapsed}/12
Average monthly GCI: $${Math.round(avgMonthlyGCI).toLocaleString()}
Simple linear projection to year end: $${Math.round(projectedYTD).toLocaleString()}

Historical monthly commissions (last 12): ${historySummary}

Provide a 3-4 sentence forecast covering:
1. Projected year-end GCI range (low/high)
2. Key factors that will influence actual outcome
3. One actionable recommendation to maximize year-end earnings

Keep it professional, specific, and data-driven. Use dollar amounts.`,
        },
      ],
    })

    return {
      success: true,
      forecast: text,
      projectedYearEnd: projectedYTD,
      avgMonthlyGCI,
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Forecast generation failed" }
  }
}

// ─── GENERATE P&L REPORT (AI-WRITTEN SUMMARY) ────────────────────────────────

export async function generatePLReport(params: {
  agentId?: string
  brokerageId: string
  isBrokerage?: boolean
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const currentYear = new Date().getFullYear()

  try {
    let grossCommission = 0
    let agentNet = 0
    let totalExpenses = 0
    let transactionCount = 0

    if (params.isBrokerage) {
      // Brokerage P&L
      const { data: ytd } = await supabase
        .from("brokerage_earnings")
        .select("gross_commission_income, brokerage_net, agent_splits_paid")
        .eq("brokerage_id", params.brokerageId)
        .eq("period_type", "ytd")
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      const { data: pl } = await supabase
        .from("brokerage_p_l")
        .select("net_profit, profit_margin_pct, operating_expenses, tech_expenses, marketing_expenses")
        .eq("brokerage_id", params.brokerageId)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      grossCommission = ytd?.gross_commission_income ?? 0
      agentNet = ytd?.brokerage_net ?? 0
      totalExpenses =
        (pl?.operating_expenses ?? 0) +
        (pl?.tech_expenses ?? 0) +
        (pl?.marketing_expenses ?? 0)
    } else if (params.agentId) {
      // Agent P&L
      const { data: ytd } = await supabase
        .from("agent_earnings")
        .select("gross_commission, agent_net, total_fees, transaction_count")
        .eq("agent_id", params.agentId)
        .eq("period_type", "ytd")
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      const { data: expenses } = await supabase
        .from("business_expenses")
        .select("amount")
        .eq("agent_id", params.agentId)
        .gte("expense_date", `${currentYear}-01-01`)

      grossCommission = ytd?.gross_commission ?? 0
      agentNet = ytd?.agent_net ?? 0
      transactionCount = ytd?.transaction_count ?? 0
      totalExpenses = expenses?.reduce((s, e: any) => s + (e.amount ?? 0), 0) ?? 0
    }

    const netProfit = agentNet - totalExpenses
    const margin =
      grossCommission > 0 ? ((netProfit / grossCommission) * 100).toFixed(1) : "0"

    const { text } = await generateTextRouted({
      feature: "unspecified",
      messages: [
        {
          role: "user",
          content: `You are a real estate financial analyst. Write a concise P&L report summary (4-6 sentences) for ${params.isBrokerage ? "a real estate brokerage" : "a real estate agent"}.

Financial Data (${currentYear} YTD):
- Gross Commission Income: $${grossCommission.toLocaleString()}
- Net Income (after splits/fees): $${agentNet.toLocaleString()}
- Business Expenses: $${totalExpenses.toLocaleString()}
- Net Profit: $${netProfit.toLocaleString()}
- Profit Margin: ${margin}%
${!params.isBrokerage ? `- Transactions Closed: ${transactionCount}` : ""}

Include:
1. Overall financial health assessment
2. Key performance indicators relative to industry benchmarks
3. Specific recommendations for improvement
Use professional language. Be direct and actionable.`,
        },
      ],
    })

    return {
      success: true,
      summary: text,
      metrics: {
        grossCommission,
        agentNet,
        totalExpenses,
        netProfit,
        margin: parseFloat(margin),
        transactionCount,
      },
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Report generation failed" }
  }
}

// ─── EXPORT COMMISSION HISTORY AS CSV ────────────────────────────────────────

export async function exportCommissionsCSV(agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const currentYear = new Date().getFullYear()

  try {
    // Use agent_commissions which has all needed columns
    const { data: commissions, error } = await supabase
      .from("agent_commissions")
      .select(
        "id, close_date, gross_commission, agent_split_percent, agent_commission, brokerage_commission, side, status, transaction_id"
      )
      .eq("agent_id", agentId)
      .eq("brokerage_id", (await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle().then(r => r.data?.brokerage_id ?? ""))!)
      .gte("close_date", `${currentYear}-01-01`)
      .order("close_date", { ascending: false })

    if (error) throw error

    // Build CSV
    const headers = [
      "Transaction ID",
      "Close Date",
      "Side",
      "Gross Commission",
      "Agent Split %",
      "Agent Commission",
      "Brokerage Commission",
      "Status",
    ]

    const rows = (commissions ?? []).map((c: any) => [
      c.transaction_id ?? "",
      c.close_date ?? "",
      c.side ?? "",
      (c.gross_commission ?? 0).toFixed(2),
      (c.agent_split_percent ?? 0).toFixed(2),
      (c.agent_commission ?? 0).toFixed(2),
      (c.brokerage_commission ?? 0).toFixed(2),
      c.status ?? "",
    ])

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n")

    return {
      success: true,
      csv,
      filename: `commissions-${currentYear}.csv`,
      rowCount: rows.length,
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Export failed" }
  }
}

// ─── EXPORT EXPENSES AS CSV ───────────────────────────────────────────────────

export async function exportExpensesCSV(agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const currentYear = new Date().getFullYear()

  try {
    const { data: expenses, error } = await supabase
      .from("business_expenses")
      .select("id, expense_date, category, description, amount, receipt_url")
      .eq("agent_id", agentId)
      .gte("expense_date", `${currentYear}-01-01`)
      .order("expense_date", { ascending: false })

    if (error) throw error

    const headers = ["Date", "Category", "Description", "Amount", "Receipt URL"]
    const rows = (expenses ?? []).map((e: any) => [
      e.expense_date ?? "",
      e.category ?? "",
      e.description ?? "",
      (e.amount ?? 0).toFixed(2),
      e.receipt_url ?? "",
    ])

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n")

    return {
      success: true,
      csv,
      filename: `expenses-${currentYear}.csv`,
      rowCount: rows.length,
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Export failed" }
  }
}

// ─── DELETE EXPENSE ───────────────────────────────────────────────────────────

export async function deleteExpense(expenseId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // business_expenses.agent_id references agents.id (not auth.users.id).
  // Resolve the caller's agent.id before scoping the delete, otherwise the
  // .eq filter silently matches nothing and the delete is a no-op.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { data: deleted, error } = await supabase
    .from("business_expenses")
    .delete()
    .eq("id", expenseId)
    .eq("agent_id", agentRow.id)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!deleted || deleted.length === 0) {
    return { success: false, error: "Expense not found or not yours to delete" }
  }

  revalidatePath("/dashboard/financials/expenses")
  revalidatePath("/dashboard/financials/agent")
  return { success: true }
}

// ─── UPDATE COMMISSION STATUS (broker only) ───────────────────────────────────

export async function updateCommissionStatus(
  commissionId: string,
  status: "pending" | "paid" | "deferred"
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const context = await getAgentContext()
  if (!["broker", "admin", "superadmin"].includes(context.userType)) {
    return { success: false, error: "Insufficient permissions" }
  }

  const { error } = await supabase
    .from("commissions")
    .update({ status, paid_date: status === "paid" ? new Date().toISOString().split("T")[0] : null })
    .eq("id", commissionId)
    .eq("brokerage_id", context.brokerageId!)

  if (error) return { success: false, error: error.message }

  revalidatePath("/dashboard/financials/commissions")
  revalidatePath("/dashboard/financials/payouts")
  return { success: true }
}
