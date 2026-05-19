import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  Users,
  UserPlus,
  BarChart3,
  MessageSquare,
  TrendingUp,
  Award,
  Activity,
  Target,
  AlertTriangle,
  Clock,
  PhoneCall,
  Calendar,
  ArrowRight,
  CheckCircle2,
} from "lucide-react"
import { CreateTeamDialog } from "./create-team-dialog"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Team Dashboard | Operations",
  description: "Team production, response health, and stuck-work insight",
}

function getInitials(first: string, last: string) {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?"
}

export default async function TeamDashboard() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId = userData.brokerage_id
  const isTeamLead = ["team_lead", "team_manager", "broker", "admin", "superadmin"].includes(
    userData.user_type ?? ""
  )

  // Fetch all dashboard data in parallel — Promise.allSettled so no single failure blocks render
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString()
  const todayStr = new Date().toISOString().split("T")[0]
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]

  const [
    membersResult,
    teamsResult,
    activeContactsResult,
    activeTransactionsResult,
    staleContactsResult,
    overdueTasksResult,
    handoffRequiredResult,
    closingsThisWeekResult,
    leaderboardResult,
    upcomingShowingsResult,
    agentUsersResult,
  ] = await Promise.allSettled([
    // 1. Team members
    supabase
      .from("users")
      .select("id, first_name, last_name, email, user_type, created_at")
      .eq("brokerage_id", brokerageId)
      .in("user_type", ["agent", "broker", "admin", "team_lead", "team_manager", "tc", "isa"])
      .order("first_name"),

    // 2. Teams in this brokerage
    supabase
      .from("teams")
      .select("id, name, team_lead_id, created_at")
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .order("name"),

    // 3. Active contacts count
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .neq("status", "archived"),

    // 4. Active transactions count (30 days)
    supabase
      .from("transactions")
      .select("id, property_address, stage, health_score, close_date, agent_id", { count: "exact" })
      .eq("brokerage_id", brokerageId)
      .not("status", "in", '("closed","cancelled")')
      .order("created_at", { ascending: false })
      .limit(20),

    // 5. Stale contacts >21 days no contact
    supabase
      .from("contacts")
      .select("id, first_name, last_name, email, last_contacted_at, status, agent_id")
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .or(`last_contacted_at.lt.${twentyOneDaysAgo},last_contacted_at.is.null`)
      .neq("status", "archived")
      .order("last_contacted_at", { ascending: true, nullsFirst: true })
      .limit(15),

    // 6. Overdue tasks
    supabase
      .from("tasks")
      .select("id, title, due_date, priority, assigned_to_agent_id, contact_id")
      .eq("brokerage_id", brokerageId)
      .eq("status", "pending")
      .lt("due_date", todayStr)
      .order("due_date")
      .limit(20),

    // 7. Handoff-required (qualified leads pending agent accept)
    supabase
      .from("agent_handoffs")
      .select("id, entity_id, entity_type, handoff_reason, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("handoff_status", "pending")
      .order("created_at", { ascending: false })
      .limit(10),

    // 8. Closings this week
    supabase
      .from("transactions")
      .select("id, property_address, close_date, agent_id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .gte("close_date", todayStr)
      .lte("close_date", weekEnd),

    // 9. Leaderboard — agent_commissions 30d
    supabase
      .from("agent_commissions")
      .select("agent_id, gross_commission, status")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", thirtyDaysAgo)
      .eq("status", "paid"),

    // 10. Upcoming showings (next 7 days)
    supabase
      .from("showings")
      .select("id, scheduled_at, scheduled_date, agent_id, contact_id, status, listing_id")
      .eq("brokerage_id", brokerageId)
      .gte("scheduled_date", todayStr)
      .lte("scheduled_date", weekEnd)
      .order("scheduled_date")
      .limit(10),

    // 11. Agents for CreateTeamDialog picker
    supabase
      .from("users")
      .select("id, first_name, last_name, email")
      .eq("brokerage_id", brokerageId)
      .in("user_type", ["agent", "broker", "team_lead"])
      .order("first_name"),
  ])

  // Safely unpack
  const members = membersResult.status === "fulfilled" ? (membersResult.value.data ?? []) : []
  const teams = teamsResult.status === "fulfilled" ? (teamsResult.value.data ?? []) : []
  const activeContactsCount =
    activeContactsResult.status === "fulfilled" ? (activeContactsResult.value.count ?? 0) : 0
  const activeTransactions =
    activeTransactionsResult.status === "fulfilled" ? (activeTransactionsResult.value.data ?? []) : []
  const staleContacts =
    staleContactsResult.status === "fulfilled" ? (staleContactsResult.value.data ?? []) : []
  const overdueTasks =
    overdueTasksResult.status === "fulfilled" ? (overdueTasksResult.value.data ?? []) : []
  const handoffs =
    handoffRequiredResult.status === "fulfilled" ? (handoffRequiredResult.value.data ?? []) : []
  const closingsThisWeek =
    closingsThisWeekResult.status === "fulfilled" ? (closingsThisWeekResult.value.count ?? 0) : 0
  const commissions =
    leaderboardResult.status === "fulfilled" ? (leaderboardResult.value.data ?? []) : []
  const upcomingShowings =
    upcomingShowingsResult.status === "fulfilled" ? (upcomingShowingsResult.value.data ?? []) : []
  const agentUsers =
    agentUsersResult.status === "fulfilled" ? (agentUsersResult.value.data ?? []) : []

  // Build leaderboard from commissions
  const gciByAgent: Record<string, number> = {}
  for (const c of commissions) {
    if (!c.agent_id) continue
    gciByAgent[c.agent_id] = (gciByAgent[c.agent_id] ?? 0) + (c.gross_commission ?? 0)
  }
  const leaderboard = Object.entries(gciByAgent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([agentId, gci]) => {
      const m = members.find((x) => x.id === agentId)
      return {
        agentId,
        name: m ? `${m.first_name} ${m.last_name}` : "Unknown",
        gci,
      }
    })

  const agentCount = members.filter((m) => m.user_type === "agent").length
  const totalMembers = members.length

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Team Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Team production, response health, and stuck-work insight
            </p>
          </div>
          {isTeamLead && (
            <CreateTeamDialog
              brokerageId={brokerageId}
              agents={agentUsers}
              userRole={userData.user_type ?? "agent"}
            />
          )}
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Command Strip */}
        <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/30 border border-border rounded-lg">
          <span className="text-sm font-semibold text-foreground mr-1">Quick Access</span>
          <Link href="/dashboard/team-heatmap">
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <Activity className="h-3 w-3" />
              Activity Heatmap
            </Button>
          </Link>
          <Link href="/dashboard/leaderboard">
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <Award className="h-3 w-3" />
              Leaderboard
            </Button>
          </Link>
          <Link href="/dashboard/coaching">
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <Target className="h-3 w-3" />
              Coaching
            </Button>
          </Link>
          <Link href="/dashboard/communications/intelligence">
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <MessageSquare className="h-3 w-3" />
              Comm Intelligence
            </Button>
          </Link>
          <Link href="/dashboard/analytics/source">
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <BarChart3 className="h-3 w-3" />
              Source Analytics
            </Button>
          </Link>
        </div>

        {/* Operating Snapshot — 6 metrics */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            {
              label: "Active Contacts",
              value: activeContactsCount,
              icon: Users,
              color: "text-blue-500",
              bg: "bg-blue-500/10",
              href: "/crm/contacts",
            },
            {
              label: "Active Transactions",
              value: activeTransactions.length,
              icon: BarChart3,
              color: "text-emerald-500",
              bg: "bg-emerald-500/10",
              href: "/dashboard/transactions",
            },
            {
              label: "Showings This Week",
              value: upcomingShowings.length,
              icon: Calendar,
              color: "text-indigo-500",
              bg: "bg-indigo-500/10",
              href: "/dashboard/calendar",
            },
            {
              label: "Stale Contacts",
              value: staleContacts.length,
              icon: Clock,
              color: "text-amber-500",
              bg: "bg-amber-500/10",
              href: "/crm/contacts",
            },
            {
              label: "Handoff Required",
              value: handoffs.length,
              icon: AlertTriangle,
              color: "text-red-500",
              bg: "bg-red-500/10",
              href: "/dashboard/communications/handoffs",
            },
            {
              label: "Overdue Tasks",
              value: overdueTasks.length,
              icon: CheckCircle2,
              color: "text-orange-500",
              bg: "bg-orange-500/10",
              href: "/dashboard/admin/tasks",
            },
          ].map((stat) => (
            <Link key={stat.label} href={stat.href}>
              <Card className="hover:border-foreground/20 transition-colors cursor-pointer h-full">
                <CardContent className="pt-4 pb-3">
                  <div className={`p-2 rounded-lg ${stat.bg} w-fit mb-2`}>
                    <stat.icon className={`h-4 w-4 ${stat.color}`} />
                  </div>
                  <p className="text-2xl font-bold text-foreground leading-none">{stat.value}</p>
                  <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        {/* Main content grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left col — Members + Leaderboard */}
          <div className="lg:col-span-2 space-y-6">
            {/* GCI Leaderboard (30-day) */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Award className="h-4 w-4" />
                    30-Day GCI Leaderboard
                  </CardTitle>
                  <Link href="/dashboard/leaderboard">
                    <Button variant="ghost" size="sm" className="text-xs gap-1 h-7">
                      Full Board <ArrowRight className="h-3 w-3" />
                    </Button>
                  </Link>
                </div>
                <CardDescription>Gross commission income — current period</CardDescription>
              </CardHeader>
              <CardContent>
                {leaderboard.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No commission data for the last 30 days.{" "}
                    <Link href="/dashboard/financials/commissions" className="underline text-primary">
                      Record commissions
                    </Link>
                  </p>
                ) : (
                  <div className="space-y-2">
                    {leaderboard.map((entry, idx) => (
                      <div
                        key={entry.agentId}
                        className="flex items-center gap-3 p-2.5 rounded-md hover:bg-muted/50 transition-colors"
                      >
                        <span className="text-sm font-bold text-muted-foreground w-5 text-center">
                          {idx + 1}
                        </span>
                        <Avatar className="h-7 w-7">
                          <AvatarFallback className="text-xs">
                            {entry.name.split(" ").map((n) => n[0]).join("").toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 text-sm font-medium truncate">{entry.name}</span>
                        <span className="text-sm font-semibold text-emerald-600">
                          ${entry.gci.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Active Transactions */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Active Transactions
                  </CardTitle>
                  <Link href="/dashboard/transactions">
                    <Button variant="ghost" size="sm" className="text-xs gap-1 h-7">
                      View All <ArrowRight className="h-3 w-3" />
                    </Button>
                  </Link>
                </div>
                <CardDescription>Open deals — health, stage, and close date</CardDescription>
              </CardHeader>
              <CardContent>
                {activeTransactions.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No active transactions.{" "}
                    <Link href="/dashboard/transactions" className="underline text-primary">
                      Create one
                    </Link>
                  </p>
                ) : (
                  <div className="space-y-2">
                    {activeTransactions.slice(0, 8).map((txn: any) => (
                      <Link key={txn.id} href={`/dashboard/transactions/${txn.id}`}>
                        <div className="flex items-center gap-3 p-2.5 rounded-md border border-border hover:bg-muted/50 transition-colors cursor-pointer">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {txn.property_address ?? "Unknown Address"}
                            </p>
                            <p className="text-xs text-muted-foreground capitalize">
                              {txn.stage?.replace(/_/g, " ") ?? "Unknown Stage"}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {txn.health_score != null && (
                              <Badge
                                variant="outline"
                                className={`text-xs ${
                                  txn.health_score >= 70
                                    ? "border-green-200 text-green-700 bg-green-50"
                                    : txn.health_score >= 40
                                    ? "border-amber-200 text-amber-700 bg-amber-50"
                                    : "border-red-200 text-red-700 bg-red-50"
                                }`}
                              >
                                {txn.health_score}
                              </Badge>
                            )}
                            {txn.close_date && (
                              <span className="text-xs text-muted-foreground">
                                {new Date(txn.close_date).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Team Members */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Team Members
                    <Badge variant="secondary" className="text-xs">{totalMembers}</Badge>
                  </CardTitle>
                  <Badge variant="outline" className="text-xs">{agentCount} agents</Badge>
                </div>
                <CardDescription>All active members in this brokerage</CardDescription>
              </CardHeader>
              <CardContent>
                {members.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No team members found.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {members.slice(0, 10).map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center gap-3 p-2.5 rounded-md border border-border hover:bg-muted/50 transition-colors"
                      >
                        <Avatar className="h-8 w-8 shrink-0">
                          <AvatarFallback className="text-xs">
                            {getInitials(m.first_name ?? "", m.last_name ?? "")}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {m.first_name} {m.last_name}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                        </div>
                        <Badge variant="outline" className="text-xs capitalize shrink-0">
                          {m.user_type ?? "agent"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right col — Stuck work, schedule, teams */}
          <div className="space-y-6">
            {/* Handoff Required */}
            <Card className={handoffs.length > 0 ? "border-red-200" : ""}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className={`h-4 w-4 ${handoffs.length > 0 ? "text-red-500" : "text-muted-foreground"}`} />
                  Handoff Required
                  {handoffs.length > 0 && (
                    <Badge variant="destructive" className="text-xs">{handoffs.length}</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {handoffs.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">No pending handoffs</p>
                ) : (
                  <div className="space-y-2">
                    {handoffs.slice(0, 5).map((h) => (
                      <Link key={h.id} href="/dashboard/communications/handoffs">
                        <div className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 text-sm cursor-pointer">
                          <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium capitalize">
                              {h.handoff_reason?.replace(/_/g, " ") ?? "Handoff pending"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(h.created_at).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                      </Link>
                    ))}
                    <Link href="/dashboard/communications/handoffs">
                      <Button variant="outline" size="sm" className="w-full text-xs mt-1">
                        View All Handoffs
                      </Button>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Stale Contacts */}
            <Card className={staleContacts.length > 5 ? "border-amber-200" : ""}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className={`h-4 w-4 ${staleContacts.length > 5 ? "text-amber-500" : "text-muted-foreground"}`} />
                  Stale Contacts
                  {staleContacts.length > 0 && (
                    <Badge variant="outline" className="text-xs border-amber-200 text-amber-700 bg-amber-50">
                      {staleContacts.length}
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-xs text-muted-foreground">No contact in 21+ days</p>
              </CardHeader>
              <CardContent>
                {staleContacts.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">
                    All contacts are active
                  </p>
                ) : (
                  <div className="space-y-2">
                    {staleContacts.slice(0, 6).map((c) => (
                      <Link key={c.id} href={`/crm/contacts/${c.id}`}>
                        <div className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer">
                          <Avatar className="h-6 w-6 shrink-0">
                            <AvatarFallback className="text-[10px]">
                              {getInitials(c.first_name ?? "", c.last_name ?? "")}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">
                              {c.first_name} {c.last_name}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {c.last_contacted_at
                                ? `Last: ${new Date(c.last_contacted_at).toLocaleDateString()}`
                                : "Never contacted"}
                            </p>
                          </div>
                        </div>
                      </Link>
                    ))}
                    <Link href="/crm/contacts">
                      <Button variant="outline" size="sm" className="w-full text-xs mt-1">
                        Work Stale Queue
                      </Button>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Overdue Tasks */}
            <Card className={overdueTasks.length > 0 ? "border-orange-200" : ""}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <CheckCircle2 className={`h-4 w-4 ${overdueTasks.length > 0 ? "text-orange-500" : "text-muted-foreground"}`} />
                  Overdue Tasks
                  {overdueTasks.length > 0 && (
                    <Badge variant="outline" className="text-xs border-orange-200 text-orange-700 bg-orange-50">
                      {overdueTasks.length}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {overdueTasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">No overdue tasks</p>
                ) : (
                  <div className="space-y-2">
                    {overdueTasks.slice(0, 5).map((t) => (
                      <div
                        key={t.id}
                        className="flex items-start gap-2 p-2 rounded-md border border-border text-xs"
                      >
                        <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-1 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{t.title}</p>
                          <p className="text-muted-foreground">
                            Due {t.due_date ? new Date(t.due_date).toLocaleDateString() : "—"}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={`text-[10px] shrink-0 capitalize ${
                            t.priority === "high"
                              ? "border-red-200 text-red-700"
                              : t.priority === "medium"
                              ? "border-amber-200 text-amber-700"
                              : "border-gray-200 text-gray-600"
                          }`}
                        >
                          {t.priority ?? "normal"}
                        </Badge>
                      </div>
                    ))}
                    <Link href="/dashboard/admin/tasks">
                      <Button variant="outline" size="sm" className="w-full text-xs mt-1">
                        Open Task Queue
                      </Button>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Upcoming Showings */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <PhoneCall className="h-4 w-4 text-muted-foreground" />
                    Showings This Week
                    <Badge variant="secondary" className="text-xs">{upcomingShowings.length}</Badge>
                  </CardTitle>
                  <Link href="/dashboard/calendar">
                    <Button variant="ghost" size="sm" className="h-6 text-xs">
                      Calendar
                    </Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {upcomingShowings.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">No showings scheduled</p>
                ) : (
                  <div className="space-y-2">
                    {upcomingShowings.slice(0, 5).map((s) => (
                      <div key={s.id} className="flex items-center gap-2 p-2 rounded-md border border-border text-xs">
                        <Calendar className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">
                            {s.scheduled_date
                              ? new Date(s.scheduled_date).toLocaleDateString()
                              : "TBD"}
                            {s.scheduled_at ? ` · ${new Date(s.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                          </p>
                        </div>
                        <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                          {s.status ?? "pending"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Teams */}
            {teams.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <UserPlus className="h-4 w-4 text-muted-foreground" />
                      Teams
                      <Badge variant="secondary" className="text-xs">{teams.length}</Badge>
                    </CardTitle>
                    <Link href="/dashboard/teams">
                      <Button variant="ghost" size="sm" className="h-6 text-xs">
                        Manage
                      </Button>
                    </Link>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {teams.map((team) => (
                      <Link key={team.id} href="/dashboard/teams">
                        <div className="flex items-center justify-between p-2.5 rounded-md border border-border hover:bg-muted/50 cursor-pointer">
                          <p className="text-sm font-medium truncate">{team.name}</p>
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        </div>
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
