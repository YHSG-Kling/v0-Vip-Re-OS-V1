import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { CoordinatorTransactionList } from "@/app/components/features/dashboard/coordinator/transaction-list"
import { DeadlineTracking } from "@/app/components/features/dashboard/coordinator/deadline-tracking"
import { MilestoneQueue } from "@/app/components/features/dashboard/coordinator/milestone-queue"
import { HealthOverview } from "@/components/coordinator/health-overview"
import {
  CoordinatorCommandStrip,
  DealPipelineRadar,
  DeadlineIntelligencePanel,
  DocumentTrackingPanel,
  ComplianceMonitorPanel,
  MilestoneOperationsPanel,
  TaskQueuePanel,
  ClosingPrepPanel,
} from "./components/os"
import { AlertCircle, UserCog, ClipboardList, Clock, CheckCircle2, Calendar } from "lucide-react"
import Link from "next/link"
import { TcFastActionPanel } from "./components/tc-fast-action-panel"

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

  // Get user data to check brokerage
  const { data: userData } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()

  // Get coordinator ID from params or lookup by user
  let coordinatorId = params.coordinatorId
  let coordinator: any = null

  if (!coordinatorId) {
    const { data: tc } = await supabase
      .from("transaction_coordinators")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle()
    coordinator = tc
    coordinatorId = tc?.id
  } else {
    const { data: tc } = await supabase.from("transaction_coordinators").select("*").eq("id", coordinatorId).maybeSingle()
    coordinator = tc
  }

  // If no coordinator profile found, show setup card
  if (!coordinatorId || !coordinator) {
    return (
      <div className="container mx-auto p-6">
        <Card className="max-w-xl mx-auto border-amber-200 bg-amber-50/50">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center">
                <UserCog className="h-6 w-6 text-amber-600" />
              </div>
              <div>
                <CardTitle className="text-lg">Transaction Coordinator Setup Required</CardTitle>
                <CardDescription className="text-amber-700">
                  No TC profile found for your account
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Your administrator needs to create a Transaction Coordinator profile for you, or you may not have the
              correct permissions to access this dashboard.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" asChild>
                <Link href="/dashboard">Return to Dashboard</Link>
              </Button>
              {(userData?.user_type === "broker" || userData?.user_type === "admin") && (
                <Button asChild>
                  <Link href="/dashboard/settings/team/tc">Setup TC Profile</Link>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Fetch assigned transactions via transaction_assignments
  const { data: assignments } = await supabase
    .from("transaction_assignments")
    .select(
      `
      id,
      is_primary,
      assigned_at,
      transaction_id,
      transactions (
        id,
        property_address,
        close_date,
        status,
        stage,
        purchase_price,
        health_score,
        agent_id,
        contact_id,
        created_at
      )
    `
    )
    .eq("coordinator_id", coordinatorId)

  // Extract transaction IDs and full transaction data
  const transactionIds = assignments?.map((a) => a.transaction_id).filter(Boolean) || []
  const transactions =
    assignments
      ?.map((a: any) => ({
        ...a.transactions,
        assignment_id: a.id,
        is_primary: a.is_primary,
        assigned_at: a.assigned_at,
      }))
      .filter((t: any) => t && t.id && t.status !== "closed" && t.status !== "cancelled") || []

  // Fetch deal health scores for assigned transactions
  const { data: healthScores } = transactionIds.length
    ? await supabase
        .from("deal_health_scores")
        .select("*")
        .in("transaction_id", transactionIds)
        .order("scored_at", { ascending: false })
    : { data: [] }

  // Get latest health score per transaction
  const healthScoreMap = new Map<string, any>()
  healthScores?.forEach((hs) => {
    if (!healthScoreMap.has(hs.transaction_id)) {
      healthScoreMap.set(hs.transaction_id, hs)
    }
  })

  // Fetch upcoming deadlines for assigned transactions
  const today = new Date().toISOString().split("T")[0]
  const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
  const { data: deadlines } = transactionIds.length
    ? await supabase
        .from("transaction_deadlines")
        .select("*, transactions(property_address)")
        .in("transaction_id", transactionIds)
        .in("status", ["pending", "in_progress"])
        .gte("deadline_date", today)
        .lte("deadline_date", twoWeeksOut)
        .order("deadline_date")
    : { data: [] }

  // Fetch incomplete milestones
  const { data: incompleteMilestones } = transactionIds.length
    ? await supabase
        .from("transaction_milestones")
        .select("*, transactions(property_address)")
        .in("transaction_id", transactionIds)
        .in("status", ["pending", "in_progress"])
        .order("milestone_date")
    : { data: [] }

  // Calculate overdue milestones
  const overdueMilestones = incompleteMilestones?.filter((m) => {
    if (!m.milestone_date) return false
    return new Date(m.milestone_date) < new Date()
  })

  // Enrich transactions with health scores
  const enrichedTransactions = transactions.map((txn: any) => ({
    ...txn,
    deal_health: healthScoreMap.get(txn.id),
  }))

  // Calculate capacity metrics
  const maxDeals = coordinator.max_active_deals || 25
  const activeCount = transactions.length
  const capacityUsed = Math.min((activeCount / maxDeals) * 100, 100)
  const isAtCapacity = activeCount >= maxDeals

  // Count closing this week
  const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const closingThisWeek = transactions.filter((t: any) => {
    if (!t.close_date) return false
    const closeDate = new Date(t.close_date)
    return closeDate <= weekFromNow && closeDate >= new Date()
  }).length

  const brokerageId = userData?.brokerage_id

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Transaction Coordination Command Center</h1>
          <p className="text-muted-foreground">
            {coordinator.display_name ? `${coordinator.display_name} - ` : ""}Managing {activeCount} active transaction
            {activeCount !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAtCapacity && (
            <Badge variant="destructive" className="gap-1">
              <AlertCircle className="h-3 w-3" />
              At Capacity
            </Badge>
          )}
          <Badge variant={capacityUsed > 80 ? "destructive" : capacityUsed > 60 ? "default" : "secondary"}>
            {capacityUsed.toFixed(0)}% Capacity
          </Badge>
        </div>
      </div>

      {/* OS Command Strip */}
      <div>
        <CoordinatorCommandStrip coordinatorId={coordinatorId} brokerageId={brokerageId || ""} />
      </div>

      {/* OS Intelligence Grid - First Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <DealPipelineRadar coordinatorId={coordinatorId} brokerageId={brokerageId || ""} />
        <DeadlineIntelligencePanel brokerageId={brokerageId || ""} />
        <DocumentTrackingPanel brokerageId={brokerageId || ""} />
      </div>

      {/* OS Intelligence Grid - Second Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ComplianceMonitorPanel brokerageId={brokerageId || ""} />
        <MilestoneOperationsPanel brokerageId={brokerageId || ""} />
        <TaskQueuePanel brokerageId={brokerageId || ""} />
      </div>

      {/* OS Closing Prep */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ClosingPrepPanel brokerageId={brokerageId || ""} />
      </div>

      {/* TC Fast Actions Panel */}
      {transactions.length > 0 && (
        <TcFastActionPanel
          transactions={transactions.map((t: any) => ({
            id: t.id,
            property_address: t.property_address ?? "",
            stage: t.stage,
          }))}
          agentId={user.id}
          brokerageId={brokerageId || ""}
          userRole={userData?.user_type ?? "tc"}
        />
      )}

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Active Transactions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount}</div>
            <Progress value={capacityUsed} className="mt-2" />
            <p className="text-xs text-muted-foreground mt-1">of {maxDeals} max capacity</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Upcoming Deadlines
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{deadlines?.length || 0}</div>
            <p className="text-xs text-muted-foreground">Next 14 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Pending Milestones
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-blue-600">{incompleteMilestones?.length || 0}</span>
              {(overdueMilestones?.length || 0) > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {overdueMilestones?.length} overdue
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Requires action</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Closing This Week
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{closingThisWeek}</div>
            <p className="text-xs text-muted-foreground">transaction{closingThisWeek !== 1 ? "s" : ""}</p>
          </CardContent>
        </Card>
      </div>

      {/* Health Overview */}
      <HealthOverview transactions={enrichedTransactions} healthScores={Array.from(healthScoreMap.values())} />

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <CoordinatorTransactionList transactions={enrichedTransactions} />
        </div>
        <div className="space-y-6">
          <DeadlineTracking deadlines={deadlines || []} />
          <MilestoneQueue milestones={incompleteMilestones || []} />
        </div>
      </div>
    </div>
  )
}
