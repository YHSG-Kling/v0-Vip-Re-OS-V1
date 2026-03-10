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
import { Building2, AlertTriangle, DollarSign, Users } from "lucide-react"
import { TierOverrideModal } from "./tier-override-modal"

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

  // Parallel data fetching
  const [brokerages, delinquent, tiers] = await Promise.all([
    getAllBrokeragesBilling(),
    getDelinquentAccounts(),
    getSubscriptionTiers(),
  ])

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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Billing Administration</h1>
        <p className="text-muted-foreground mt-1">
          Manage brokerage subscriptions and billing across the platform
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-4">
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
