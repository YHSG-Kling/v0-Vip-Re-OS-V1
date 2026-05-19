import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Users,
  UserPlus,
  Calendar,
  TrendingUp,
  AlertTriangle,
  Phone,
  Mail,
  Clock,
  Target,
  Activity
} from "lucide-react"

export const dynamic = "force-dynamic"

export default async function BuyersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Fetch buyer contacts with engagement data
  const [
    { data: buyers },
    { count: totalBuyers },
    { count: hotLeads },
    { count: scheduledTours },
    { data: recentEngagement }
  ] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, contact_type, buyer_stage, status, engagement_score, intent_score, last_contacted_at, created_at")
      .eq("agent_id", user.id)
      .eq("contact_type", "buyer")
      .is("deleted_at", null)
      .order("last_contacted_at", { ascending: false, nullsFirst: false })
      .limit(20),
    supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", user.id)
      .eq("contact_type", "buyer")
      .is("deleted_at", null),
    supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", user.id)
      .eq("contact_type", "buyer")
      .is("deleted_at", null)
      .gte("intent_score", 70),
    supabase
      .from("showings")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", user.id)
      .gte("scheduled_date", new Date().toISOString().split("T")[0]),
    supabase
      .from("activities")
      .select("id, activity_type, title, description, created_at")
      .eq("agent_id", user.id)
      .eq("entity_type", "contact")
      .order("created_at", { ascending: false })
      .limit(5)
  ])

  // Calculate stale leads (not contacted in 7+ days) — use last_contacted_at (live schema column)
  const staleLeads = buyers?.filter(b => {
    if (!b.last_contacted_at) return true
    const daysSinceContact = (Date.now() - new Date(b.last_contacted_at).getTime()) / (1000 * 60 * 60 * 24)
    return daysSinceContact > 7
  }).length || 0

  // buyer_stage values from contacts.buyer_stage (BuyerStage type in kernel)
  const getStageColor = (stage: string) => {
    switch (stage?.toUpperCase()) {
      case "NEW":                return "bg-slate-100 text-slate-700 border-slate-200"
      case "FINANCIALLY_VERIFIED": return "bg-green-100 text-green-700 border-green-200"
      case "SEARCHING":          return "bg-blue-100 text-blue-700 border-blue-200"
      case "OFFER_ELIGIBLE":     return "bg-indigo-100 text-indigo-700 border-indigo-200"
      case "OFFER_SUBMITTED":    return "bg-amber-100 text-amber-700 border-amber-200"
      case "UNDER_CONTRACT":     return "bg-orange-100 text-orange-700 border-orange-200"
      case "CLOSED":             return "bg-emerald-100 text-emerald-700 border-emerald-200"
      case "DISENGAGED":         return "bg-red-100 text-red-700 border-red-200"
      default:                   return "bg-gray-100 text-gray-700 border-gray-200"
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="px-6 py-4">
          <h1 className="text-2xl font-bold text-foreground">Buyer Intelligence</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your buyer leads, track engagement, and optimize conversions
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Command Strip */}
        <div className="flex flex-wrap items-center gap-3 p-4 bg-muted/30 border border-border rounded-lg">
          <span className="text-sm font-semibold text-foreground">Buyer Operations</span>
          <div className="flex gap-2 flex-wrap">
            <Link href="/crm/contacts/new?type=buyer">
              <Button size="sm" variant="default" className="text-xs gap-1">
                <UserPlus className="h-3 w-3" />
                Add Buyer
              </Button>
            </Link>
            <Link href="/dashboard/isa/calendar">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Calendar className="h-3 w-3" />
                ISA Calendar
              </Button>
            </Link>
            <Link href="/dashboard/buyers/fatigue">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <AlertTriangle className="h-3 w-3" />
                Fatigue Monitor
              </Button>
            </Link>
            <Link href="/leads">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Target className="h-3 w-3" />
                Lead Intelligence
              </Button>
            </Link>
            <Link href="/dashboard/isa/calling">
              <Button size="sm" variant="outline" className="text-xs gap-1">
                <Phone className="h-3 w-3" />
                Power Dialer
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
                  <p className="text-2xl font-bold text-foreground">{totalBuyers || 0}</p>
                  <p className="text-xs text-muted-foreground">Total Buyers</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-red-500/10">
                  <TrendingUp className="h-5 w-5 text-red-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{hotLeads || 0}</p>
                  <p className="text-xs text-muted-foreground">Hot Leads</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Calendar className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{scheduledTours || 0}</p>
                  <p className="text-xs text-muted-foreground">Scheduled Tours</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <Clock className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{staleLeads}</p>
                  <p className="text-xs text-muted-foreground">Need Follow-up</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Buyers List */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5" />
                Active Buyers
              </CardTitle>
              <CardDescription>Your buyer leads and prospects</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Name</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Contact</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Stage</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {buyers && buyers.length > 0 ? (
                      buyers.slice(0, 10).map((buyer) => (
                        <tr key={buyer.id} className="hover:bg-muted/50">
                          <td className="px-4 py-3">
                            {/* Canonical CRM route: /crm?contact=<id> */}
                            <Link href={`/crm?contact=${buyer.id}`} className="text-sm font-medium text-foreground hover:text-primary">
                              {buyer.first_name} {buyer.last_name}
                            </Link>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {buyer.phone && (
                                <a href={`tel:${buyer.phone}`} className="text-muted-foreground hover:text-foreground">
                                  <Phone className="h-3 w-3" />
                                </a>
                              )}
                              {buyer.email && (
                                <a href={`mailto:${buyer.email}`} className="text-muted-foreground hover:text-foreground">
                                  <Mail className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {/* buyer_stage is the live schema column (contacts.buyer_stage) */}
                            <Badge variant="outline" className={`text-xs ${getStageColor(buyer.buyer_stage ?? "")}`}>
                              {buyer.buyer_stage?.replace(/_/g, " ").toLowerCase() || buyer.status || "new"}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {/* engagement_score is the live schema column (contacts.engagement_score) */}
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    (buyer.engagement_score || 0) >= 70 ? "bg-green-500" :
                                    (buyer.engagement_score || 0) >= 40 ? "bg-amber-500" : "bg-gray-400"
                                  }`}
                                  style={{ width: `${Math.min(buyer.engagement_score || 0, 100)}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground">{buyer.engagement_score || 0}</span>
                            </div>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                          No buyer leads found. Add your first buyer to get started.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {buyers && buyers.length > 10 && (
                <div className="mt-4 text-center">
                  <Link href="/crm?contact_type=buyer">
                    <Button variant="outline" size="sm">View All Buyers</Button>
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Engagement */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Recent Engagement
              </CardTitle>
              <CardDescription>Latest buyer interactions</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentEngagement && recentEngagement.length > 0 ? (
                  recentEngagement.map((activity) => (
                    <div key={activity.id} className="flex items-start gap-3 p-3 rounded-lg border border-border">
                      <div className="w-2 h-2 rounded-full bg-blue-500 mt-2" />
                      <div className="flex-1 min-w-0">
                        {/* activities table uses title + description columns (not action) */}
                        <p className="text-sm text-foreground truncate">
                          {activity.title || activity.activity_type}
                        </p>
                        {activity.description && (
                          <p className="text-xs text-muted-foreground truncate">{activity.description}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {new Date(activity.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No recent engagement
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
