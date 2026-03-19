import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Plus,
  FileText,
  DollarSign,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Calendar,
  TrendingUp,
  BarChart3,
  Sparkles,
} from "lucide-react"

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

  // Fetch transactions with health data
  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      id, 
      property_address, 
      transaction_type,
      status, 
      contract_price, 
      close_date,
      created_at,
      deal_health (
        overall_score,
        risk_level
      )
    `)
    .eq("agent_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50)

  // Calculate stats
  const activeDeals = transactions?.filter(t => t.status === "active" || t.status === "pending") || []
  const closedThisYear = transactions?.filter(t => {
    if (t.status !== "closed" || !t.close_date) return false
    return new Date(t.close_date).getFullYear() === new Date().getFullYear()
  }) || []
  const totalActiveVolume = activeDeals.reduce((sum, t) => sum + (t.contract_price || 0), 0)
  const atRiskDeals = activeDeals.filter(t => {
    const health = Array.isArray(t.deal_health) ? t.deal_health[0] : t.deal_health
    return health?.risk_level === "high" || health?.risk_level === "critical"
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
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/transactions/new">
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            New Transaction
          </Button>
        </Link>
        <Link href="/dashboard/transactions/timeline">
          <Button variant="outline" size="sm" className="gap-2">
            <Calendar className="h-4 w-4" />
            Timeline View
          </Button>
        </Link>
        <Link href="/dashboard/transactions/reports">
          <Button variant="outline" size="sm" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            Reports
          </Button>
        </Link>
        <div className="flex-1" />
        <Link href="/dashboard/transactions/health">
          <Button variant="ghost" size="sm" className="gap-2 text-primary">
            <Sparkles className="h-4 w-4" />
            Deal Health AI
          </Button>
        </Link>
      </div>

      <div className="px-6 space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Transaction Command Center</h1>
          <p className="text-muted-foreground">Monitor deal progress and pipeline health</p>
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
              <Badge variant="secondary">{transactions?.length || 0} total</Badge>
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
                  {transactions && transactions.length > 0 ? (
                    transactions.map((tx) => {
                      const statusConfig = STATUS_CONFIG[tx.status] || STATUS_CONFIG.active
                      const health = Array.isArray(tx.deal_health) ? tx.deal_health[0] : tx.deal_health
                      const healthScore = health?.overall_score
                      const riskLevel = health?.risk_level

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
                            {tx.transaction_type || "purchase"}
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-foreground">
                            ${tx.contract_price?.toLocaleString() || "TBD"}
                          </td>
                          <td className="px-4 py-3">
                            <Badge className={`${statusConfig.bgColor} ${statusConfig.color}`}>
                              {statusConfig.label}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {healthScore !== undefined ? (
                              <div className="flex items-center gap-2">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                  riskLevel === "low" ? "bg-green-100 text-green-700" :
                                  riskLevel === "medium" ? "bg-amber-100 text-amber-700" :
                                  "bg-red-100 text-red-700"
                                }`}>
                                  {healthScore}
                                </div>
                              </div>
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
                      <td colSpan={7} className="px-4 py-8 text-center">
                        <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                        <p className="text-muted-foreground mb-4">No transactions found. Start a new transaction to track your deals.</p>
                        <Link href="/transactions/new">
                          <Button>
                            <Plus className="h-4 w-4 mr-2" />
                            New Transaction
                          </Button>
                        </Link>
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
