import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import {
  getAllBrokeragesBilling,
  getDelinquentAccounts,
  getSubscriptionTiers,
} from "@/app/actions/billing"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Building2, AlertTriangle, DollarSign, Users, Phone, Clock, Zap } from "lucide-react"
import { TierOverrideModal } from "./tier-override-modal"
import { CreateSubscriberModal } from "./create-subscriber-modal"

export const dynamic = "force-dynamic"

export default async function AdminBillingPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle()

  // Role gate: superadmin only
  if (profile?.role !== "superadmin") {
    redirect("/dashboard")
  }

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString()

  // Parallel data fetching
  const [brokerages, delinquent, tiers, vapiUsageResult, vapiTiersResult] = await Promise.all([
    getAllBrokeragesBilling(),
    getDelinquentAccounts(),
    getSubscriptionTiers(),
    // VAPI voice minutes used this month, grouped by brokerage
    supabase
      .from("vapi_voice_calls")
      .select("brokerage_id, minutes_billed, cost_cents, duration_seconds, created_at")
      .gte("created_at", monthStart)
      .lte("created_at", monthEnd),
    // Tier billing rates per brokerage
    supabase
      .from("ai_subscription_tier")
      .select("brokerage_id, team_id, tier_name, monthly_budget_cents"),
  ])

  // Aggregate VAPI usage per brokerage
  type BrokerageUsage = { minutes: number; cost: number; calls: number }
  const vapiByBrokerage = new Map<string, BrokerageUsage>()
  for (const row of vapiUsageResult.data ?? []) {
    if (!row.brokerage_id) continue
    const cur = vapiByBrokerage.get(row.brokerage_id) ?? { minutes: 0, cost: 0, calls: 0 }
    cur.minutes += row.minutes_billed ?? 0
    cur.cost += row.cost_cents ?? 0
    cur.calls += 1
    vapiByBrokerage.set(row.brokerage_id, cur)
  }

  const totalVapiMinutes = Array.from(vapiByBrokerage.values()).reduce((s, v) => s + v.minutes, 0)
  const totalVapiCost = Array.from(vapiByBrokerage.values()).reduce((s, v) => s + v.cost, 0)

  // Map tier budgets per brokerage
  const tierByBrokerage = new Map<string, { tier_name: string; monthly_budget_cents: number }>()
  for (const t of vapiTiersResult.data ?? []) {
    if (t.brokerage_id && !t.team_id) {
      tierByBrokerage.set(t.brokerage_id, { tier_name: t.tier_name, monthly_budget_cents: t.monthly_budget_cents })
    }
  }

  // Calculate MRR
  const totalMrr = brokerages.reduce((sum, b) => {
    const sub = b.subscriptions?.[0]
    if (sub?.status === "active" && sub.subscription_tiers?.monthly_price_cents) {
      return sum + sub.subscription_tiers.monthly_price_cents
    }
    return sum
  }, 0)

  const activeSubscriptions = brokerages.filter(
    b => b.subscriptions?.[0]?.status === "active"
  ).length

  const getStatusBadge = (status: string | undefined) => {
    switch (status) {
      case "active":
        return <Badge className="bg-green-100 text-green-800">Active</Badge>
      case "trialing":
        return <Badge className="bg-blue-100 text-blue-800">Trial</Badge>
      case "past_due":
        return <Badge className="bg-red-100 text-red-800">Past Due</Badge>
      case "cancelled":
        return <Badge className="bg-gray-100 text-gray-800">Cancelled</Badge>
      default:
        return <Badge variant="outline">No Plan</Badge>
    }
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Billing Administration</h1>
          <p className="text-muted-foreground mt-1">
            Manage brokerage subscriptions and billing across the platform
          </p>
        </div>
        <CreateSubscriberModal tiers={tiers} onCreated={() => {}} />
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Monthly Recurring Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(totalMrr / 100).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">From active subscriptions</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Total Brokerages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{brokerages.length}</div>
            <p className="text-xs text-muted-foreground">All registered</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Active Subscriptions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{activeSubscriptions}</div>
            <p className="text-xs text-muted-foreground">Paying customers</p>
          </CardContent>
        </Card>

        <Card className="bg-indigo-50/50 border-indigo-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-indigo-700 flex items-center gap-2">
              <Phone className="h-4 w-4" />
              VAPI Voice Minutes MTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-indigo-900">{totalVapiMinutes.toLocaleString()}</div>
            <p className="text-xs text-indigo-600">AI outbound calling</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Delinquent
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{delinquent.length}</div>
            <p className="text-xs text-muted-foreground">Past due accounts</p>
          </CardContent>
        </Card>
      </div>

      {/* VAPI Voice Usage Section */}
      <Card className="border-indigo-200 bg-indigo-50/30">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-indigo-900">
                <Phone className="h-5 w-5 text-indigo-600" />
                VAPI Voice Usage (Month-to-Date)
              </CardTitle>
              <CardDescription className="text-indigo-700">
                AI outbound calling minutes per brokerage, with tier billing rates
              </CardDescription>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-indigo-900">${(totalVapiCost / 100).toFixed(2)}</div>
              <p className="text-xs text-indigo-600">Total Voice Cost MTD</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {vapiByBrokerage.size === 0 ? (
            <div className="text-center py-8">
              <Phone className="w-10 h-10 text-indigo-300 mx-auto mb-2" />
              <p className="text-sm text-indigo-700">No VAPI voice usage recorded this month</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-white/50">
                  <TableHead>Brokerage</TableHead>
                  <TableHead className="text-right">Tier</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Minutes</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead className="text-right">% Used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from(vapiByBrokerage.entries())
                  .sort((a, b) => b[1].cost - a[1].cost)
                  .map(([brokerageId, usage]) => {
                    const brokerage = brokerages.find((b: any) => b.id === brokerageId)
                    const tier = tierByBrokerage.get(brokerageId)
                    const budget = tier?.monthly_budget_cents ?? 0
                    const pctUsed = budget > 0 ? (usage.cost / budget) * 100 : 0
                    const isOverBudget = pctUsed > 100

                    return (
                      <TableRow key={brokerageId} className={isOverBudget ? 'bg-red-50' : ''}>
                        <TableCell className="font-medium">{brokerage?.name ?? 'Unknown'}</TableCell>
                        <TableCell className="text-right">
                          {tier?.tier_name ? (
                            <Badge variant="outline" className="text-xs">
                              {tier.tier_name}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-indigo-700 font-medium">
                          {usage.calls}
                        </TableCell>
                        <TableCell className="text-right text-indigo-900 font-semibold">
                          {usage.minutes}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          ${(usage.cost / 100).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {budget > 0 ? `$${(budget / 100).toFixed(2)}` : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          {budget > 0 ? (
                            <div className="flex items-center gap-1.5 justify-end">
                              <div className="w-16 bg-gray-200 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className={`h-full ${isOverBudget ? 'bg-red-600' : pctUsed > 80 ? 'bg-amber-500' : 'bg-green-500'}`}
                                  style={{ width: `${Math.min(pctUsed, 100)}%` }}
                                />
                              </div>
                              <span className={`text-xs font-medium ${isOverBudget ? 'text-red-600' : pctUsed > 80 ? 'text-amber-600' : 'text-green-600'}`}>
                                {pctUsed.toFixed(0)}%
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Delinquent Accounts */}
      {delinquent.length > 0 && (
        <Card className="border-red-200 bg-red-50/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-800">
              <AlertTriangle className="h-5 w-5" />
              Delinquent Accounts
            </CardTitle>
            <CardDescription className="text-red-700">
              These accounts have past due payments and require attention
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Brokerage</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Period End</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {delinquent.map((account: any) => (
                  <TableRow key={account.id}>
                    <TableCell className="font-medium">
                      {account.brokerages?.name || "Unknown"}
                    </TableCell>
                    <TableCell>
                      {account.subscription_tiers?.display_name || "N/A"}
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-red-100 text-red-800">Past Due</Badge>
                    </TableCell>
                    <TableCell>
                      {account.current_period_end
                        ? new Date(account.current_period_end).toLocaleDateString()
                        : "N/A"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* All Brokerages */}
      <Card>
        <CardHeader>
          <CardTitle>All Brokerages</CardTitle>
          <CardDescription>
            Complete list of brokerages with their subscription status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Brokerage</TableHead>
                <TableHead>Current Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>MRR</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {brokerages.map((brokerage: any) => {
                const subscription = brokerage.subscriptions?.[0]
                const tier = subscription?.subscription_tiers
                const mrr = subscription?.status === "active" && tier?.monthly_price_cents
                  ? tier.monthly_price_cents / 100
                  : 0

                return (
                  <TableRow key={brokerage.id}>
                    <TableCell className="font-medium">{brokerage.name}</TableCell>
                    <TableCell>{tier?.display_name || "None"}</TableCell>
                    <TableCell>{getStatusBadge(subscription?.status)}</TableCell>
                    <TableCell>${mrr.toFixed(2)}</TableCell>
                    <TableCell className="text-right">
                      {subscription && (
                        <TierOverrideModal
                          subscriptionId={subscription.id}
                          currentTierId={tier?.id}
                          brokerageName={brokerage.name}
                          tiers={tiers}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
