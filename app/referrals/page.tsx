import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getReferralROI, getReferralLeaderboard, getReferrals } from "@/app/actions/referral-management"
import { aiScoreSphereEngagement } from "@/app/actions/ai-sphere-management"
import { getLeaderboardWidget } from "@/app/actions/gamification"
import { PlusCircle, Users, DollarSign, TrendingUp, Award } from "lucide-react"
import Link from "next/link"
import { CreateReferralSheet } from "@/app/components/referrals/CreateReferralSheet"
import { getAgentContext } from "@/lib/identity"
import { ReferralsOsClient } from "./referrals-os-client"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function ReferralsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>
}) {
  const params = await searchParams
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Calculate date windows
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
  const oneYearAgo = new Date()
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
  const anniversaryWindowEnd = new Date(oneYearAgo)
  anniversaryWindowEnd.setDate(anniversaryWindowEnd.getDate() + 30)

  const [stats, leaderboard, referrals, sphereScore, leaderboardWidget, recentClosingsRes, existingReviewsRes, anniversaryTransactionsRes] = await Promise.all([
    getReferralROI(),
    getReferralLeaderboard(),
    getReferrals({ agentId: agentId!, brokerageId: brokerageId! }),
    aiScoreSphereEngagement({ agentId: agentId! }).catch(() => null),
    getLeaderboardWidget({ agentId: agentId!, brokerageId: brokerageId! }).catch(() => null),
    // Recent closings for review requests (last 90 days)
    supabase
      .from("transactions")
      .select("id, property_address, close_date, contact_id, contacts(id, first_name, last_name)")
      .eq("agent_id", agentId)
      .eq("status", "closed")
      .gte("close_date", ninetyDaysAgo)
      .order("close_date", { ascending: false })
      .limit(5),
    // Existing reviews
    supabase
      .from("agent_reviews")
      .select("id, platform, rating, review_text")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(10),
    // Upcoming anniversaries (contacts with transactions that closed ~1 year ago)
    supabase
      .from("transactions")
      .select("id, property_address, close_date, contacts(id, first_name, last_name)")
      .eq("agent_id", agentId)
      .eq("status", "closed")
      .gte("close_date", oneYearAgo.toISOString().split("T")[0])
      .lte("close_date", anniversaryWindowEnd.toISOString().split("T")[0])
      .limit(5),
  ])

  // Format data for components
  const recentClosings = (recentClosingsRes.data || []).map((t: any) => ({
    id: t.id,
    contact_id: t.contacts?.id || t.contact_id || "",
    contactName: t.contacts ? `${t.contacts.first_name || ""} ${t.contacts.last_name || ""}`.trim() : "Unknown",
    address: t.property_address || "",
    closeDate: t.close_date || "",
    transactionId: t.id,
  }))

  const existingReviews = (existingReviewsRes.data || []).map((r: any) => ({
    id: r.id,
    platform: r.platform || "google",
    rating: r.rating || 0,
    review_text: r.review_text || "",
  }))

  const upcomingAnniversaries = (anniversaryTransactionsRes.data || []).map((t: any) => ({
    contactId: t.contacts?.id || "",
    contactName: t.contacts ? `${t.contacts.first_name || ""} ${t.contacts.last_name || ""}`.trim() : "Unknown",
    address: t.property_address || "",
    yearsCount: 1,
    closeDate: t.close_date || "",
  }))

  const isCreateOpen = params.action === "create"
  const pendingReferrals = referrals?.filter((r: any) => r.status === "new" || r.status === "contacted").length || 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* OS Command Strip + Pipeline + Action Stack */}
      <ReferralsOsClient
        agentId={agentId!}
        brokerageId={brokerageId!}
        referralCount={stats.totalReferrals}
        pendingReferrals={pendingReferrals}
        roiSummary={{
          totalReferrals: stats.totalReferrals,
          converted: (stats as any).closed,
          conversionRate: stats.conversionRate,
          totalValue: stats.totalValue,
        }}
        referrals={(referrals || []).map((r: any) => ({
          id: r.id,
          referral_name: r.referred_name,
          status: r.status,
          source_contact_id: r.referring_contact_id,
          source_contact_name: r.referring_contact
            ? `${r.referring_contact.first_name} ${r.referring_contact.last_name}`
            : undefined,
          created_at: r.referral_date,
          value_estimate: r.potential_value,
        }))}
        sphereScore={sphereScore}
        leaderboardWidget={leaderboardWidget}
        recentClosings={recentClosings}
        existingReviews={existingReviews}
        upcomingAnniversaries={upcomingAnniversaries}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Referral Management</h1>
          <p className="text-muted-foreground">Track and manage your referral pipeline</p>
        </div>
        <Link href="?action=create">
          <Button>
            <PlusCircle className="w-4 h-4 mr-2" />
            New Referral
          </Button>
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Referrals</p>
              <p className="text-2xl font-bold">{stats.totalReferrals}</p>
            </div>
            <Users className="w-8 h-8 text-muted-foreground" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Contacted</p>
              <p className="text-2xl font-bold">{(stats as any).contacted}</p>
            </div>
            <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
              C
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Qualified</p>
              <p className="text-2xl font-bold">{(stats as any).qualified}</p>
            </div>
            <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-bold">
              Q
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Closed</p>
              <p className="text-2xl font-bold">{(stats as any).closed}</p>
            </div>
            <Award className="w-8 h-8 text-yellow-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Value</p>
              <p className="text-2xl font-bold">${(stats.totalValue / 1000).toFixed(0)}K</p>
            </div>
            <DollarSign className="w-8 h-8 text-green-600" />
          </div>
        </Card>
      </div>

      {/* Conversion Rate */}
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold mb-2">Conversion Rate</h3>
            <p className="text-4xl font-bold text-green-600">{stats.conversionRate.toFixed(1)}%</p>
            <p className="text-sm text-muted-foreground mt-1">
              {(stats as any).closed} of {stats.totalReferrals} referrals closed
            </p>
          </div>
          <TrendingUp className="w-16 h-16 text-green-600" />
        </div>
      </Card>

      {/* Leaderboard */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Award className="w-5 h-5 text-yellow-500" />
          Top Referrers
        </h3>
        <div className="space-y-3">
          {leaderboard.map((item: any, index) => (
            <div key={index} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
                    index === 0
                      ? "bg-yellow-100 text-yellow-700"
                      : index === 1
                        ? "bg-gray-100 text-gray-700"
                        : index === 2
                          ? "bg-orange-100 text-orange-700"
                          : "bg-muted text-muted-foreground"
                  }`}
                >
                  #{index + 1}
                </div>
                <div>
                  <p className="font-medium">
                    {item.contact?.first_name} {item.contact?.last_name}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold">{item.count}</p>
                <p className="text-xs text-muted-foreground">referrals</p>
              </div>
            </div>
          ))}
          {leaderboard.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              No referrals yet. Start tracking referrals to see your top referrers!
            </p>
          )}
        </div>
      </Card>

      {/* Quick Links */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/referrals/pipeline">
          <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer">
            <h3 className="font-semibold mb-2">Referral Pipeline</h3>
            <p className="text-sm text-muted-foreground">View and manage all referrals</p>
          </Card>
        </Link>
        <Link href="/dashboard/agent/referrals">
          <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer">
            <h3 className="font-semibold mb-2">Referral Partners</h3>
            <p className="text-sm text-muted-foreground">Manage your partner network</p>
          </Card>
        </Link>
        <Link href="/past-clients">
          <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer">
            <h3 className="font-semibold mb-2">Past Clients</h3>
            <p className="text-sm text-muted-foreground">Touchpoint calendar & engagement</p>
          </Card>
        </Link>
      </div>

      {isCreateOpen && <CreateReferralSheet />}
    </div>
  )
}
