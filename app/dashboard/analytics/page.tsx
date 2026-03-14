import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TrendingUp, Users, Home, DollarSign } from "lucide-react"

export default async function AnalyticsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Fetch summary stats
  const [contactsResult, listingsResult, transactionsResult] = await Promise.all([
    supabase.from("contacts").select("id", { count: "exact", head: true }).eq("agent_id", user.id),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("agent_id", user.id),
    supabase.from("transactions").select("id, contract_price", { count: "exact" }).eq("agent_id", user.id).eq("status", "closed"),
  ])

  const totalContacts = contactsResult.count || 0
  const totalListings = listingsResult.count || 0
  const closedTransactions = transactionsResult.count || 0
  const totalVolume = transactionsResult.data?.reduce((sum, tx) => sum + (tx.contract_price || 0), 0) || 0

  const stats = [
    {
      title: "Total Contacts",
      value: totalContacts.toLocaleString(),
      description: "Active contacts in your CRM",
      icon: Users,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Active Listings",
      value: totalListings.toLocaleString(),
      description: "Properties on the market",
      icon: Home,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Closed Deals",
      value: closedTransactions.toLocaleString(),
      description: "Successfully closed transactions",
      icon: TrendingUp,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
    },
    {
      title: "Total Volume",
      value: `$${(totalVolume / 1000000).toFixed(1)}M`,
      description: "Closed transaction volume",
      icon: DollarSign,
      color: "text-emerald-600",
      bgColor: "bg-emerald-50",
    },
  ]

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
          <p className="text-muted-foreground">Track your performance and metrics</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon
          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.title}
                </CardTitle>
                <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                  <Icon className={`h-4 w-4 ${stat.color}`} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-foreground">{stat.value}</div>
                <p className="text-xs text-muted-foreground">{stat.description}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance Overview</CardTitle>
          <CardDescription>Your activity metrics over time</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64 flex items-center justify-center border border-dashed border-border rounded-lg">
            <p className="text-muted-foreground">Charts and detailed analytics coming soon</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
