import { createClient } from "@/lib/supabase/server"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar, Heart, TrendingUp, Gift } from "lucide-react"
import { getAgentContext } from "@/lib/identity"

export const dynamic = "force-dynamic"

export default async function PastClientsPage() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Get past clients (contacts with closed transactions)
  const { data: pastClients } = await supabase
    .from("contacts")
    .select(
      `
      *,
      transactions!inner(id, actual_close_date, status),
      client_engagement_scores(engagement_score, referral_potential_score, last_touchpoint_date)
    `,
    )
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .eq("transactions.status", "closed")

  // Get upcoming touchpoints
  const today = new Date()
  const nextWeek = new Date(today)
  nextWeek.setDate(nextWeek.getDate() + 7)

  const { data: upcomingTouchpoints } = await supabase
    .from("past_client_touchpoints")
    .select("*, contacts(first_name, last_name)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .eq("status", "scheduled")
    .gte("scheduled_date", today.toISOString().split("T")[0])
    .lte("scheduled_date", nextWeek.toISOString().split("T")[0])
    .order("scheduled_date")
    .limit(10)

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Past Clients</h1>
          <p className="text-muted-foreground">Client for Life touchpoint management</p>
        </div>
        <Button>
          <Calendar className="w-4 h-4 mr-2" />
          View Calendar
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Past Clients</p>
              <p className="text-2xl font-bold">{pastClients?.length || 0}</p>
            </div>
            <Heart className="w-8 h-8 text-red-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">High Engagement</p>
              <p className="text-2xl font-bold">
                {pastClients?.filter((c) => (c.client_engagement_scores?.[0]?.engagement_score || 0) >= 70).length || 0}
              </p>
            </div>
            <TrendingUp className="w-8 h-8 text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Upcoming Touchpoints</p>
              <p className="text-2xl font-bold">{upcomingTouchpoints?.length || 0}</p>
            </div>
            <Calendar className="w-8 h-8 text-blue-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Referral Ready</p>
              <p className="text-2xl font-bold">
                {pastClients?.filter((c) => (c.client_engagement_scores?.[0]?.referral_potential_score || 0) >= 75)
                  .length || 0}
              </p>
            </div>
            <Gift className="w-8 h-8 text-purple-500" />
          </div>
        </Card>
      </div>

      {/* Upcoming Touchpoints */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">Upcoming Touchpoints (Next 7 Days)</h2>
        <div className="space-y-3">
          {upcomingTouchpoints?.map((touchpoint) => (
            <div key={touchpoint.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
                  <Calendar className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <p className="font-medium">
                    {touchpoint.contacts?.first_name} {touchpoint.contacts?.last_name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {touchpoint.touchpoint_type.replace(/_/g, " ")} • {touchpoint.channel}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-medium">{new Date(touchpoint.scheduled_date).toLocaleDateString()}</p>
                <Button size="sm" variant="outline" className="mt-1 bg-transparent">
                  Send Now
                </Button>
              </div>
            </div>
          ))}
          {(!upcomingTouchpoints || upcomingTouchpoints.length === 0) && (
            <p className="text-center text-muted-foreground py-4">No touchpoints scheduled for the next 7 days</p>
          )}
        </div>
      </Card>

      {/* Past Clients List */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">All Past Clients</h2>
        <div className="space-y-3">
          {pastClients?.map((client) => {
            const engagementScore = client.client_engagement_scores?.[0]?.engagement_score || 0
            const referralScore = client.client_engagement_scores?.[0]?.referral_potential_score || 0
            const lastTouchpoint = client.client_engagement_scores?.[0]?.last_touchpoint_date

            return (
              <div key={client.id} className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-semibold">
                      {client.first_name} {client.last_name}
                    </h3>
                    {engagementScore >= 70 && <Badge className="bg-green-100 text-green-700">High Engagement</Badge>}
                    {referralScore >= 75 && <Badge className="bg-purple-100 text-purple-700">Referral Ready</Badge>}
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Engagement Score</p>
                      <p className="font-medium">{engagementScore}/100</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Referral Potential</p>
                      <p className="font-medium">{referralScore}/100</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Last Touchpoint</p>
                      <p className="font-medium">
                        {lastTouchpoint ? new Date(lastTouchpoint).toLocaleDateString() : "Never"}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline">
                    View
                  </Button>
                  <Button size="sm">Schedule Touchpoint</Button>
                </div>
              </div>
            )
          })}
          {(!pastClients || pastClients.length === 0) && (
            <p className="text-center text-muted-foreground py-8">No past clients yet</p>
          )}
        </div>
      </Card>
    </div>
  )
}
