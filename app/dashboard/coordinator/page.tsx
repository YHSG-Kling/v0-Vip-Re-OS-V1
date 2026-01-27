import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { getCoordinatorDashboard } from "@/app/actions/multi-persona"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { CoordinatorTransactionList } from "@/components/coordinator/transaction-list"
import { DeadlineTracking } from "@/components/coordinator/deadline-tracking"
import { MilestoneQueue } from "@/components/coordinator/milestone-queue"

export default async function CoordinatorDashboard({
  searchParams,
}: {
  searchParams: Promise<{ coordinatorId?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Get coordinator ID from params or lookup by user
  let coordinatorId = params.coordinatorId
  if (!coordinatorId) {
    const { data: tc } = await supabase.from("transaction_coordinators").select("id").eq("user_id", user.id).single()
    coordinatorId = tc?.id
  }

  if (!coordinatorId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">No coordinator profile found. Please contact your administrator.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const dashboard = await getCoordinatorDashboard(coordinatorId)
  const { coordinator, transactions, deadlines, incompleteMilestones } = dashboard

  if (!coordinator) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">Coordinator not found.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const capacityUsed = (coordinator.active_transactions_count / coordinator.max_transactions_capacity) * 100

  const closingThisWeek =
    transactions?.filter((t: any) => {
      const closing = new Date(t.closing_date)
      const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      return closing <= weekFromNow && closing >= new Date()
    }).length || 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Transaction Coordination</h1>
          <p className="text-muted-foreground">Managing {coordinator.active_transactions_count} active transactions</p>
        </div>
        <Badge variant={capacityUsed > 80 ? "destructive" : "default"} className="text-sm">
          {capacityUsed.toFixed(0)}% Capacity
        </Badge>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{coordinator.active_transactions_count}</div>
            <Progress value={capacityUsed} className="mt-2" />
            <p className="text-xs text-muted-foreground mt-1">of {coordinator.max_transactions_capacity} capacity</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Upcoming Deadlines</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{deadlines?.length || 0}</div>
            <p className="text-xs text-muted-foreground">Next 7 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Milestones</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{incompleteMilestones?.length || 0}</div>
            <p className="text-xs text-muted-foreground">Requires action</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Closing This Week</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{closingThisWeek}</div>
            <p className="text-xs text-muted-foreground">transactions</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <CoordinatorTransactionList transactions={transactions || []} />
        </div>
        <div className="space-y-6">
          <DeadlineTracking deadlines={deadlines || []} />
          <MilestoneQueue milestones={incompleteMilestones || []} />
        </div>
      </div>
    </div>
  )
}
