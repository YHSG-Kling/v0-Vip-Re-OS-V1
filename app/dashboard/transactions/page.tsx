import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getTransactions } from "@/app/actions/transactions"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  FileText,
  DollarSign,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Calendar,
  TrendingUp,
  Plus,
} from "lucide-react"
import { TransactionCommandStrip } from "./components/transaction-command-strip"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export const dynamic = "force-dynamic"

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string; icon: typeof CheckCircle2 }> = {
  active: { label: "Active", color: "text-green-700", bgColor: "bg-green-100", icon: TrendingUp },
  pending: { label: "Pending", color: "text-amber-700", bgColor: "bg-amber-100", icon: Clock },
  closed: { label: "Closed", color: "text-blue-700", bgColor: "bg-blue-100", icon: CheckCircle2 },
  cancelled: { label: "Cancelled", color: "text-red-700", bgColor: "bg-red-100", icon: AlertTriangle },
}

export default async function TransactionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Look up agent record — transactions.agent_id = agents.id, not users.id
  const { data: agentRecord } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const agentId = agentRecord?.id ?? user.id
  const brokerageId = agentRecord?.brokerage_id ?? null

  const { data: brokerageInfo } = brokerageId
    ? await supabase.from("brokerages").select("name, logo_url").eq("id", brokerageId).maybeSingle()
    : { data: null }

  // Fetch transactions using server action (proper architecture pattern)
  // getTransactions returns { success, data } or { success: false, error }
  const txResult = await getTransactions({
    agent_id: agentId,
    ...(brokerageId ? { brokerage_id: brokerageId } : {}),
  })
  const transactions = (txResult && "data" in txResult ? txResult.data : null) ?? []

  // Fetch deal_health_scores separately — no FK join supported from transactions
  const txIds = transactions.map((t: any) => t.id)
  const { data: healthScores } = txIds.length > 0
    ? await supabase
        .from("deal_health_scores")
        .select("transaction_id, overall_score, risk_level")
        .in("transaction_id", txIds)
        .order("scored_at", { ascending: false })
    : { data: [] }

  // Key health scores by transaction_id (most recent per tx wins due to ordering)
  const healthByTxId = (healthScores ?? []).reduce((acc, h) => {
    if (!acc[h.transaction_id]) acc[h.transaction_id] = h
    return acc
  }, {} as Record<string, { overall_score: number; risk_level: string }>)

  // Calculate stats
  const activeDeals = transactions.filter(t => {
    const s = (t.status ?? "").toLowerCase()
    return s === "active" || s === "pending" || s === "in_progress"
  })
  const closedThisYear = transactions.filter(t => {
    if ((t.status ?? "").toLowerCase() !== "closed" || !t.close_date) return false
    return new Date(t.close_date).getFullYear() === new Date().getFullYear()
  })
  const totalActiveVolume = activeDeals.reduce((sum, t) => sum + (t.purchase_price || 0), 0)
  const atRiskDeals = activeDeals.filter(t => {
    const health = healthByTxId[t.id]
    if (!health) return false
    const rl = (health.risk_level ?? "").toLowerCase()
    return rl === "high" || rl === "critical" || rl === "medium" || rl === "at_risk" || health.overall_score < 60
  })

  // Calculate days to close for active deals
  const upcomingClosings = activeDeals
    .filter(t => t.close_date)
    .map(t => ({
      ...t,
      daysToClose: Math.ceil((new Date(t.close_date!).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    }))
    .filter(t => t.daysToClose > 0 && t.daysToClose <= 30)
    .sort((a, b) => a.daysToClose - b.daysToClose)

  return (
    <div className="space-y-6">
      {/* Command Strip */}
      <TransactionCommandStrip />

      <div className="px-4 sm:px-6 space-y-6">
        {/* Page Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground text-balance">Transaction Command Center</h1>
            <p className="text-muted-foreground text-sm">Monitor deal progress and pipeline health</p>
          </div>
          {(brokerageInfo?.name || brokerageInfo?.logo_url) && (
            <div className="flex items-center gap-2 shrink-0">
              {brokerageInfo.logo_url ? (
                <img src={brokerageInfo.logo_url} alt={brokerageInfo.name ?? "Brokerage"} className="h-8 w-auto max-w-[120px] object-contain" />
              ) : (
                <span className="text-sm font-medium text-muted-foreground">{brokerageInfo.name}</span>
              )}
            </div>
          )}
        </div>

        {/* Status Radar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="border-l-4 border-l-green-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Deals</p>
                  <p className="text-2xl font-bold text-foreground">{activeDeals.length}</p>
                </div>
                <FileText className="h-8 w-8 text-green-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Pipeline Volume</p>
                  <p className="text-2xl font-bold text-foreground">
                    ${(totalActiveVolume / 1000000).toFixed(1)}M
                  </p>
                </div>
                <DollarSign className="h-8 w-8 text-blue-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-amber-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Closing in 30 Days</p>
                  <p className="text-2xl font-bold text-foreground">{upcomingClosings.length}</p>
                </div>
                <Clock className="h-8 w-8 text-amber-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card className={`border-l-4 ${atRiskDeals.length > 0 ? "border-l-red-500" : "border-l-purple-500"}`}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">At Risk</p>
                  <p className="text-2xl font-bold text-foreground">{atRiskDeals.length}</p>
                </div>
                <AlertTriangle className={`h-8 w-8 opacity-50 ${atRiskDeals.length > 0 ? "text-red-500" : "text-purple-500"}`} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Upcoming Closings Alert */}
        {upcomingClosings.length > 0 && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-amber-800 flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Upcoming Closings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {upcomingClosings.slice(0, 5).map(tx => (
                  <Link key={tx.id} href={`/dashboard/transactions/${tx.id}`}>
                    <Badge variant="outline" className="bg-white hover:bg-amber-100 cursor-pointer">
                      {tx.property_address?.split(",")[0] || "TBD"} - {tx.daysToClose}d
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Transactions Table */}
        <Card>
          <CardHeader className="border-b border-border">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">All Transactions</CardTitle>
              <Badge variant="secondary">{transactions.length} total</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Property</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Type</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Price</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Health</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Close Date</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {transactions.length > 0 ? (
                    transactions.map((tx) => {
                      const statusConfig = STATUS_CONFIG[(tx.status ?? "").toLowerCase()] || STATUS_CONFIG.active
                      // Health scores fetched separately above and keyed by transaction_id
                      const health = healthByTxId[tx.id]
                      const healthScore = health?.overall_score
                      const riskLevel = health?.risk_level
                      const normalizedRisk = riskLevel?.toLowerCase()
                      const isAtRisk = normalizedRisk === "high" || normalizedRisk === "critical" || normalizedRisk === "medium" || normalizedRisk === "at_risk"

                      return (
                        <tr key={tx.id} className="hover:bg-muted/50 group">
                          <td className="px-4 py-3">
                            <Link
                              href={`/dashboard/transactions/${tx.id}`}
                              className="text-sm font-medium text-foreground hover:text-primary"
                            >
                              {tx.property_address || "Pending Address"}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground capitalize">
                            {/* Live schema column is deal_type, not transaction_type */}
                            {tx.deal_type || "purchase"}
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-foreground">
                            {/* Live schema column is purchase_price, not contract_price */}
                            ${tx.purchase_price?.toLocaleString() || "TBD"}
                          </td>
                          <td className="px-4 py-3">
                            <Badge className={`${statusConfig.bgColor} ${statusConfig.color}`}>
                              {statusConfig.label}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {healthScore !== undefined ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="flex items-center gap-1.5 cursor-help w-fit">
                                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                        normalizedRisk === "low" || normalizedRisk === "healthy" ? "bg-green-100 text-green-700" :
                                        isAtRisk && !(normalizedRisk === "critical" || normalizedRisk === "high") ? "bg-amber-100 text-amber-700" :
                                        (normalizedRisk === "critical" || normalizedRisk === "high") ? "bg-red-100 text-red-700" :
                                        "bg-gray-100 text-gray-600"
                                      }`}>
                                        {healthScore}
                                      </div>
                                      {isAtRisk && (
                                        <AlertTriangle className={`h-3 w-3 ${(normalizedRisk === "critical" || normalizedRisk === "high") ? "text-red-500" : "text-amber-500"}`} />
                                      )}
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-xs text-xs">
                                    <p className="font-semibold mb-1">
                                      Health Score: {healthScore}/100 · {riskLevel?.replace(/_/g, " ") ?? "unknown"}
                                    </p>
                                    {isAtRisk && (
                                      <p className="text-muted-foreground">
                                        This deal has risk factors. Open to view full report.
                                      </p>
                                    )}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <span className="text-xs text-muted-foreground">--</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {tx.close_date ? new Date(tx.close_date).toLocaleDateString() : "TBD"}
                          </td>
                          <td className="px-4 py-3">
                            <Link href={`/dashboard/transactions/${tx.id}`}>
                              <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                            </Link>
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center">
                        <FileText className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
                        <p className="text-base font-medium text-foreground mb-1">No active transactions</p>
                        <p className="text-sm text-muted-foreground mb-6">
                          Start tracking your deals by creating a transaction.
                        </p>
                        <div className="flex items-center justify-center gap-3">
                          {/* /dashboard/transactions/new does not exist — link to contacts to start a transaction */}
                          <Link href="/crm">
                            <Button>
                              <Plus className="h-4 w-4 mr-2" />
                              Create from Contact
                            </Button>
                          </Link>
                          {/* /dashboard/offers does not exist — offers live under buyers/[id]/offers */}
                          <Link href="/dashboard/buyers">
                            <Button variant="outline">
                              Convert from Offer
                            </Button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
