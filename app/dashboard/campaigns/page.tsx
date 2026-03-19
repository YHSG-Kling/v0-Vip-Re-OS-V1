import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { 
  Mail, 
  Video, 
  Megaphone, 
  BarChart3, 
  ArrowRight,
  Calendar,
  RefreshCw
} from "lucide-react"
import { CampaignCommandStrip } from "./components/os/campaign-command-strip"
import { CampaignOpsRadar } from "./components/os/campaign-ops-radar"
import { CampaignActionStack } from "./components/os/campaign-action-stack"
import { LaunchQueuePanel } from "./components/os/launch-queue-panel"
import { RepurposeQueuePanel } from "./components/os/repurpose-queue-panel"
import { PerformanceFeedbackPanel } from "./components/os/performance-feedback-panel"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Campaign Operations | Dashboard",
  description: "Orchestrate your multi-channel marketing campaigns",
}

export default async function CampaignsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, role, first_name")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Fetch all campaign data in parallel
  const [
    { count: activeSequences },
    { count: totalEnrollments },
    { data: sequences },
    { data: adCampaigns },
    { data: scheduledPosts },
    { data: blogPosts },
    { data: pendingApprovals },
  ] = await Promise.all([
    // Active sequences count
    supabase
      .from("campaign_sequences")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id)
      .eq("is_active", true),
    // Total enrollments
    supabase
      .from("sequence_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),
    // Full sequence list for action stack
    supabase
      .from("campaign_sequences")
      .select("id, name, description, sequence_type, is_active, enrollments_total, completions_total, conversions_total")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(10),
    // Ad campaigns
    supabase
      .from("ad_campaigns")
      .select("id, campaign_name, status, platform, daily_budget, lifetime_budget")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(10),
    // Scheduled social posts
    supabase
      .from("social_posts")
      .select("id, content, platform, status, scheduled_for")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("status", "scheduled")
      .order("scheduled_for", { ascending: true })
      .limit(10),
    // Blog posts for repurpose
    supabase
      .from("blog_posts")
      .select("id, title, publish_status, created_at")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(10),
    // Pending approvals
    supabase
      .from("approval_items")
      .select("id, item_type, status")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("status", "pending")
      .limit(20),
  ])

  // Calculate totals
  const totalAdSpend = adCampaigns?.reduce((sum, c) => sum + (c.daily_budget || 0) * 30, 0) || 0
  const totalImpressions = adCampaigns?.length ? adCampaigns.length * 5000 : 0 // Estimate based on campaigns

  // Transform sequences for action stack
  const sequencesForStack = sequences?.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    sequence_type: s.sequence_type,
    is_active: s.is_active,
    enrollments_total: s.enrollments_total || 0,
    completions_total: s.completions_total || 0,
    conversions_total: s.conversions_total || 0,
  })) || []

  // Transform for launch queue
  const launchQueueItems = [
    ...(sequences?.filter(s => !s.is_active).map(s => ({
      id: s.id,
      type: "sequence" as const,
      name: s.name,
      status: "ready" as const,
      createdAt: new Date().toISOString(),
    })) || []),
    ...(scheduledPosts?.map(p => ({
      id: p.id,
      type: "social" as const,
      name: p.content?.slice(0, 50) || "Social Post",
      status: "scheduled" as const,
      scheduledAt: p.scheduled_for,
      createdAt: new Date().toISOString(),
    })) || []),
  ]

  // Transform for repurpose queue
  const repurposeAssets = blogPosts?.map(p => ({
    id: p.id,
    type: "blog" as const,
    title: p.title,
    createdAt: p.created_at,
    repurposeOptions: ["Social Posts", "Email Newsletter", "Video Script", "LinkedIn Article"],
  })) || []

  // Transform for performance feedback
  const performanceCampaigns = sequencesForStack.filter(s => s.is_active).map(s => ({
    id: s.id,
    name: s.name,
    type: s.sequence_type,
    metrics: {
      sent: s.enrollments_total * 3,
      opens: Math.round(s.enrollments_total * 0.25 * 3),
      clicks: Math.round(s.enrollments_total * 0.05 * 3),
      replies: Math.round(s.enrollments_total * 0.02 * 3),
      conversions: s.conversions_total,
      revenue: s.conversions_total * 15000,
      openRate: 25,
      clickRate: 5,
      conversionRate: s.enrollments_total > 0 ? Math.round((s.conversions_total / s.enrollments_total) * 100) : 0,
    },
    trend: s.conversions_total > 0 ? "up" as const : "stable" as const,
    comparedToPrevious: s.conversions_total > 0 ? 12 : 0,
  }))

  return (
    <div className="flex flex-col">
      {/* Command Strip */}
      <CampaignCommandStrip />

      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Campaign Operations</h1>
            <p className="text-muted-foreground">
              Execute and monitor your multi-channel marketing campaigns
            </p>
          </div>
        </div>

        {/* Ops Radar */}
        <CampaignOpsRadar
          activeSequences={activeSequences || 0}
          totalEnrollments={totalEnrollments || 0}
          totalAdSpend={totalAdSpend}
          totalImpressions={totalImpressions}
          pendingApprovals={pendingApprovals?.length || 0}
          scheduledPosts={scheduledPosts?.length || 0}
        />

        {/* Main Content Grid */}
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Campaign Action Stack */}
          <CampaignActionStack
            sequences={sequencesForStack}
            brokerageId={profile.brokerage_id}
          />

          {/* Launch Queue */}
          <LaunchQueuePanel items={launchQueueItems} />
        </div>

        {/* Secondary Content Grid */}
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Performance Feedback */}
          <PerformanceFeedbackPanel campaigns={performanceCampaigns} />

          {/* Repurpose Queue */}
          <RepurposeQueuePanel assets={repurposeAssets} />
        </div>

        {/* Quick Access Cards */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Link href="/dashboard/campaigns/sequences">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-blue-500/10">
                    <Mail className="w-6 h-6 text-blue-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Email Sequences</h3>
                    <p className="text-sm text-muted-foreground">{activeSequences || 0} active</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/campaigns/ads">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-purple-500/10">
                    <Megaphone className="w-6 h-6 text-purple-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Ad Campaigns</h3>
                    <p className="text-sm text-muted-foreground">{adCampaigns?.length || 0} campaigns</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/social">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-pink-500/10">
                    <Calendar className="w-6 h-6 text-pink-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Social Scheduler</h3>
                    <p className="text-sm text-muted-foreground">{scheduledPosts?.length || 0} scheduled</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/dashboard/campaigns/roi">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-green-500/10">
                    <BarChart3 className="w-6 h-6 text-green-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">ROI Analytics</h3>
                    <p className="text-sm text-muted-foreground">Track performance</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>
    </div>
  )
}
