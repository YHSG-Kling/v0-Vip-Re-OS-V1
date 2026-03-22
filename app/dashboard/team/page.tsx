import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
  Plus,
} from "lucide-react"
import { CreateTeamDialog } from "./create-team-dialog"

export const dynamic = "force-dynamic"

export default async function TeamPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Get user's brokerage and role
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Fetch team members with performance data
  const { data: teamMembers } = await supabase
    .from("users")
    .select("id, first_name, last_name, email, user_type, avatar_url, status, role")
    .eq("brokerage_id", userData.brokerage_id)
    .order("first_name")
    .limit(50)

  // Fetch team stats
  const [
    { count: activeAgents },
    { count: totalTransactions },
    { data: recentActivity },
    { data: existingTeams },
  ] = await Promise.all([
    supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", userData.brokerage_id)
      .eq("status", "active"),
    supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", userData.brokerage_id)
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    supabase
      .from("activity_log")
      .select("id, action, created_at, user_id")
      .eq("brokerage_id", userData.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("teams")
      .select("id, name, team_lead_id, created_at")
      .eq("brokerage_id", userData.brokerage_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  ])

  const getInitials = (firstName: string, lastName: string) => {
    return `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase()
  }

  const rolesByType = {
    agents: teamMembers?.filter(m => m.role === "agent" || m.user_type === "agent") || [],
    admins: teamMembers?.filter(m => ["admin", "broker"].includes(m.role || "")) || [],
    support: teamMembers?.filter(m => ["tc", "isa", "coordinator"].includes(m.role || "")) || [],
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="px-6 py-4">
          <h1 className="text-2xl font-bold text-foreground">Team Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            View and manage your team members, performance, and collaboration
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Command Strip */}
        <div className="flex flex-wrap items-center gap-3 p-4 bg-muted/30 border border-border rounded-lg">
          <span className="text-sm font-semibold text-foreground">Team Operations</span>
          <div className="flex gap-2 flex-wrap">
            <Link href="/dashboard/team-heatmap">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Activity className="h-3 w-3" />
                Activity Heatmap
              </Button>
            </Link>
            <Link href="/dashboard/leaderboard">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Award className="h-3 w-3" />
                Leaderboard
              </Button>
            </Link>
            <Link href="/dashboard/coaching">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Target className="h-3 w-3" />
                Coaching
              </Button>
            </Link>
            <Link href="/dashboard/communications/intelligence">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <MessageSquare className="h-3 w-3" />
                Comm Intelligence
              </Button>
            </Link>
          </div>
        </div>

        {/* Status Radar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <Users className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{activeAgents || 0}</p>
                  <p className="text-xs text-muted-foreground">Active Members</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <TrendingUp className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{totalTransactions || 0}</p>
                  <p className="text-xs text-muted-foreground">30-Day Transactions</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <UserPlus className="h-5 w-5 text-purple-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{rolesByType.agents.length}</p>
                  <p className="text-xs text-muted-foreground">Agents</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <BarChart3 className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{rolesByType.support.length}</p>
                  <p className="text-xs text-muted-foreground">Support Staff</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Team Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Agents */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5" />
                Team Members
              </CardTitle>
              <CardDescription>All active team members in your brokerage</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {teamMembers && teamMembers.length > 0 ? (
                  teamMembers.slice(0, 8).map((member) => (
                    <div key={member.id} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={member.avatar_url || undefined} />
                        <AvatarFallback className="text-sm">
                          {getInitials(member.first_name || "", member.last_name || "")}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm text-foreground truncate">
                          {member.first_name} {member.last_name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Badge variant="outline" className="capitalize text-xs">
                          {member.role || member.user_type || "agent"}
                        </Badge>
                        <span className={`w-2 h-2 rounded-full ${member.status === "active" ? "bg-green-500" : "bg-gray-400"}`} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="col-span-2 py-8 text-center text-muted-foreground">
                    No team members found. Team members will appear here once added to your brokerage.
                  </div>
                )}
              </div>
              {teamMembers && teamMembers.length > 8 && (
                <div className="mt-4 text-center">
                  <Button variant="outline" size="sm">
                    View All {teamMembers.length} Members
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Recent Activity
              </CardTitle>
              <CardDescription>Latest team actions</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentActivity && recentActivity.length > 0 ? (
                  recentActivity.map((activity) => (
                    <div key={activity.id} className="flex items-start gap-3 p-2 rounded border border-border">
                      <div className="w-2 h-2 rounded-full bg-blue-500 mt-2" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{activity.action}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(activity.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No recent activity
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
