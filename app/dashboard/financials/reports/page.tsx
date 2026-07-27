import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Download, FileText, Calendar, DollarSign, TrendingUp } from "lucide-react"
import Link from "next/link"
import { ReportsClient } from "./reports-client"

export const dynamic = "force-dynamic"

export default async function FinancialReportsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const context = await ensureAgentContextInPlace()
  if (!context.isAuthenticated) redirect("/login")
  if (!context.brokerageId) redirect("/dashboard/onboarding")

  const { agentId, brokerageId, userId, userType } = context
  const currentYear = new Date().getFullYear()

  // Fetch real transaction and commission data in parallel
  const [earningsResult, commissionsResult, expensesResult, savedReportsResult] = await Promise.all([
    // Agent YTD earnings
    supabase
      .from("agent_earnings")
      .select("gross_commission, agent_net, total_fees, transaction_count, cap_status, cap_progress_pct")
      .eq("agent_id", agentId)
      .eq("period_type", "ytd")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(r => r.data),

    // Closed commissions for this agent
    supabase
      .from("agent_commissions")
      .select("id, close_date, gross_commission, agent_commission, brokerage_commission, status, side, transaction_id")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .gte("close_date", `${currentYear}-01-01`)
      .order("close_date", { ascending: false })
      .limit(50)
      .then(r => r.data ?? []),

    // YTD expenses
    supabase
      .from("business_expenses")
      .select("amount, category, expense_date")
      .eq("agent_id", agentId)
      .gte("expense_date", `${currentYear}-01-01`)
      .then(r => r.data ?? []),

    // Saved P&L snapshots persisted by aiGenerateProfitLossReport (financial_reports.agent_id is agents.id)
    supabase
      .from("financial_reports")
      .select("id, report_type, period_start, period_end, total_income, total_expenses, net_profit, generated_at")
      .eq("agent_id", agentId)
      .order("generated_at", { ascending: false })
      .limit(12)
      .then(r => r.data ?? []),
  ])

  const ytdCommissions = earningsResult?.gross_commission ?? 0
  const ytdAgentNet = earningsResult?.agent_net ?? 0
  const closedCount = earningsResult?.transaction_count ?? commissionsResult.filter((c: any) => c.status === "paid").length
  const ytdVolume = commissionsResult.reduce((s: number, c: any) => s + (c.gross_commission ?? 0), 0)
  const ytdExpenses = expensesResult.reduce((s: number, e: any) => s + (e.amount ?? 0), 0)

  return (
    <div className="space-y-6">
      {/* Command Strip */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/dashboard/financials">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Financials
          </Button>
        </Link>
      </div>

      <div className="px-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Financial Reports</h1>
          <p className="text-muted-foreground">Download statements, commission history, and expense summaries</p>
        </div>

        {/* YTD Summary */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <DollarSign className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(ytdCommissions)}
                  </p>
                  <p className="text-xs text-muted-foreground">YTD GCI</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <TrendingUp className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(ytdAgentNet)}
                  </p>
                  <p className="text-xs text-muted-foreground">YTD Net Income</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <FileText className="h-5 w-5 text-purple-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{closedCount}</p>
                  <p className="text-xs text-muted-foreground">Closed Transactions</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <Calendar className="h-5 w-5 text-orange-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(ytdExpenses)}
                  </p>
                  <p className="text-xs text-muted-foreground">YTD Expenses</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Saved reports — P&L snapshots persisted by the AI report generator */}
        <Card>
          <CardHeader>
            <CardTitle>Saved Reports</CardTitle>
            <CardDescription>Previously generated P&amp;L snapshots for this agent</CardDescription>
          </CardHeader>
          <CardContent>
            {savedReportsResult.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved reports yet. Generate a P&amp;L report to create one.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Period</th>
                      <th className="py-2 pr-4 font-medium">Type</th>
                      <th className="py-2 pr-4 font-medium text-right">Income</th>
                      <th className="py-2 pr-4 font-medium text-right">Expenses</th>
                      <th className="py-2 pr-4 font-medium text-right">Net</th>
                      <th className="py-2 font-medium">Generated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {savedReportsResult.map((report: any) => (
                      <tr key={report.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-4">
                          {report.period_start && report.period_end
                            ? `${new Date(report.period_start).toLocaleDateString()} – ${new Date(report.period_end).toLocaleDateString()}`
                            : "—"}
                        </td>
                        <td className="py-2 pr-4 capitalize">{(report.report_type ?? "").replace(/_/g, " ") || "—"}</td>
                        <td className="py-2 pr-4 text-right">
                          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(report.total_income ?? 0)}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(report.total_expenses ?? 0)}
                        </td>
                        <td className={`py-2 pr-4 text-right font-medium ${(report.net_profit ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(report.net_profit ?? 0)}
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {report.generated_at ? new Date(report.generated_at).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Client component handles export/download actions */}
        <ReportsClient
          agentId={agentId ?? ""}
          brokerageId={brokerageId ?? ""}
          commissions={commissionsResult}
          currentYear={currentYear}
          ytdCommissions={ytdCommissions}
          ytdAgentNet={ytdAgentNet}
          ytdExpenses={ytdExpenses}
        />
      </div>
    </div>
  )
}
