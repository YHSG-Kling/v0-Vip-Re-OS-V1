import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { 
  DollarSign, 
  TrendingUp, 
  PiggyBank, 
  CreditCard,
  ArrowRight,
  Calendar,
  FileText,
  Clock,
  CheckCircle2,
  AlertTriangle
} from "lucide-react"

export const dynamic = "force-dynamic"

async function getFinancialOverview(agentId: string, brokerageId: string) {
  const supabase = await createClient()
  
  // Get commission splits
  const { data: commissionSplits } = await supabase
    .from("commission_splits")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(10)

  // Get pending payouts
  const { data: pendingPayouts } = await supabase
    .from("commission_splits")
    .select("agent_amount")
    .eq("agent_id", agentId)
    .eq("status", "pending")

  // Get YTD earnings
  const startOfYear = new Date(new Date().getFullYear(), 0, 1).toISOString()
  const { data: ytdEarnings } = await supabase
    .from("commission_splits")
    .select("agent_amount")
    .eq("agent_id", agentId)
    .eq("status", "paid")
    .gte("paid_at", startOfYear)

  // Get recent transactions with commission data
  const { data: recentTransactions } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      sale_price,
      status,
      closing_date,
      commission_splits (
        agent_amount,
        status
      )
    `)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(5)

  const totalPending = pendingPayouts?.reduce((sum, p) => sum + (p.agent_amount || 0), 0) || 0
  const totalYTD = ytdEarnings?.reduce((sum, e) => sum + (e.agent_amount || 0), 0) || 0

  return {
    commissionSplits: commissionSplits || [],
    pendingPayouts: totalPending,
    ytdEarnings: totalYTD,
    recentTransactions: recentTransactions || [],
    pendingCount: pendingPayouts?.length || 0,
  }
}

export default async function FinancialsPage() {
  const context = await getAgentContext()
  
  if (!context?.agentId) {
    redirect("/login")
  }

  const financials = await getFinancialOverview(context.agentId, context.brokerageId || "")

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Command Strip */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Financial Command</h1>
          <p className="text-muted-foreground">Track earnings, commissions, and payouts</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/financials/commissions">
            <Button variant="outline">
              <FileText className="w-4 h-4 mr-2" />
              Commission History
            </Button>
          </Link>
          <Link href="/dashboard/financials/payouts">
            <Button>
              <DollarSign className="w-4 h-4 mr-2" />
              View Payouts
            </Button>
          </Link>
        </div>
      </div>

      {/* Financial Radar - Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">YTD Earnings</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">
              {formatCurrency(financials.ytdEarnings)}
            </div>
            <p className="text-xs text-muted-foreground">
              Paid commissions this year
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pending Payouts</CardTitle>
            <Clock className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">
              {formatCurrency(financials.pendingPayouts)}
            </div>
            <p className="text-xs text-muted-foreground">
              {financials.pendingCount} transactions awaiting payout
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Commission</CardTitle>
            <PiggyBank className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {financials.commissionSplits.length > 0 
                ? formatCurrency(
                    financials.commissionSplits.reduce((sum, c) => sum + (c.agent_amount || 0), 0) / 
                    financials.commissionSplits.length
                  )
                : "$0"
              }
            </div>
            <p className="text-xs text-muted-foreground">
              Per transaction average
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">This Month</CardTitle>
            <Calendar className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {financials.recentTransactions.filter(t => 
                t.closing_date && new Date(t.closing_date).getMonth() === new Date().getMonth()
              ).length} deals
            </div>
            <p className="text-xs text-muted-foreground">
              Closed this month
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Transactions Panel */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Transactions</CardTitle>
              <CardDescription>Your latest deals and commission status</CardDescription>
            </div>
            <Link href="/dashboard/transactions">
              <Button variant="ghost" size="sm">
                View All <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {financials.recentTransactions.length > 0 ? (
            <div className="space-y-4">
              {financials.recentTransactions.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-1">
                    <p className="font-medium">{tx.property_address || "Property Address"}</p>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>{formatCurrency(tx.sale_price || 0)}</span>
                      {tx.closing_date && (
                        <>
                          <span>•</span>
                          <span>{new Date(tx.closing_date).toLocaleDateString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {tx.commission_splits?.[0] && (
                      <span className="font-semibold text-emerald-600">
                        {formatCurrency(tx.commission_splits[0].agent_amount || 0)}
                      </span>
                    )}
                    <Badge variant={
                      tx.commission_splits?.[0]?.status === "paid" ? "default" :
                      tx.commission_splits?.[0]?.status === "pending" ? "secondary" : "outline"
                    }>
                      {tx.commission_splits?.[0]?.status === "paid" && <CheckCircle2 className="w-3 h-3 mr-1" />}
                      {tx.commission_splits?.[0]?.status === "pending" && <Clock className="w-3 h-3 mr-1" />}
                      {tx.commission_splits?.[0]?.status || tx.status || "pending"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <DollarSign className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p>No recent transactions</p>
              <p className="text-sm">Commissions will appear here as deals close</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/dashboard/financials/commissions">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-lg bg-blue-500/10">
                  <FileText className="w-6 h-6 text-blue-500" />
                </div>
                <div>
                  <h3 className="font-semibold">Commission History</h3>
                  <p className="text-sm text-muted-foreground">View all commission splits</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/financials/payouts">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-lg bg-emerald-500/10">
                  <CreditCard className="w-6 h-6 text-emerald-500" />
                </div>
                <div>
                  <h3 className="font-semibold">Payout Settings</h3>
                  <p className="text-sm text-muted-foreground">Manage payment preferences</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/financials/reports">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-lg bg-purple-500/10">
                  <TrendingUp className="w-6 h-6 text-purple-500" />
                </div>
                <div>
                  <h3 className="font-semibold">Financial Reports</h3>
                  <p className="text-sm text-muted-foreground">Download statements & 1099s</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
