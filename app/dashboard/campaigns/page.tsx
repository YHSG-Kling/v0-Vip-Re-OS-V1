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
  TrendingUp,
  Users,
  Target,
  Zap,
  Calendar,
  PlayCircle,
  RefreshCw
} from "lucide-react"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Marketing Campaigns | Dashboard",
  description: "Manage all your marketing campaigns, sequences, and automations",
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
    redirect("/onboarding")
  }

  // Fetch campaign stats
  const [
    { count: activeSequences },
    { count: totalEnrollments },
    { data: recentCampaigns },
    { data: adCampaigns },
  ] = await Promise.all([
    supabase
      .from("campaign_sequences")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id)
      .eq("is_active", true),
    supabase
      .from("sequence_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("newsletter_campaigns")
      .select("id, campaign_name, status, campaign_type, created_at")
      .eq("agent_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("ad_campaigns")
      .select("id, campaign_name, status, platform, total_spend, total_impressions")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(5),
  ])

  // Calculate totals
  const totalAdSpend = adCampaigns?.reduce((sum, c) => sum + (c.total_spend || 0), 0) || 0
  const totalImpressions = adCampaigns?.reduce((sum, c) => sum + (c.total_impressions || 0), 0) || 0

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Marketing Campaigns</h1>
        <p className="text-muted-foreground">
          Orchestrate your multi-channel marketing from one command center
        </p>
      </div>

      {/* Command Strip */}
      <div className="flex flex-wrap gap-2">
        <Link href="/dashboard/campaigns/sequences">
          <Button variant="outline" size="sm" className="gap-2">
            <Mail className="h-4 w-4" />
            Email Sequences
          </Button>
        </Link>
        <Link href="/dashboard/campaigns/ads">
          <Button variant="outline" size="sm" className="gap-2">
            <Megaphone className="h-4 w-4" />
            Ad Campaigns
          </Button>
        </Link>
        <Link href="/dashboard/campaigns/roi">
          <Button variant="outline" size="sm" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            ROI Analytics
          </Button>
        </Link>
        <Link href="/dashboard/campaigns/repurpose">
          <Button variant="outline" size="sm" className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Content Repurpose
          </Button>
        </Link>
        <Link href="/dashboard/videos/create">
          <Button variant="outline" size="sm" className="gap-2">
            <Video className="h-4 w-4" />
            AI Video
          </Button>
        </Link>
      </div>

      {/* Status Radar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <Zap className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{activeSequences || 0}</p>
                <p className="text-sm text-muted-foreground">Active Sequences</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Users className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{totalEnrollments || 0}</p>
                <p className="text-sm text-muted-foreground">Active Enrollments</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                <Target className="h-5 w-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">${totalAdSpend.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground">Ad Spend (30d)</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <TrendingUp className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{(totalImpressions / 1000).toFixed(1)}K</p>
                <p className="text-sm text-muted-foreground">Impressions</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Campaign Hubs Grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Email Sequences Hub */}
        <Card className="group hover:shadow-md transition-shadow">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Mail className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              </div>
              <Badge variant="secondary">{activeSequences || 0} active</Badge>
            </div>
            <CardTitle className="mt-4">Email Sequences</CardTitle>
            <CardDescription>
              Automated drip campaigns, nurture sequences, and behavioral triggers
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-4">
              {recentCampaigns?.slice(0, 3).map((campaign) => (
                <div key={campaign.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">{campaign.campaign_name}</span>
                  <Badge variant={campaign.status === "active" ? "default" : "outline"} className="text-xs">
                    {campaign.status}
                  </Badge>
                </div>
              ))}
              {(!recentCampaigns || recentCampaigns.length === 0) && (
                <p className="text-sm text-muted-foreground">No campaigns yet</p>
              )}
            </div>
            <Link href="/dashboard/campaigns/sequences">
              <Button variant="outline" className="w-full gap-2 group-hover:bg-accent">
                Manage Sequences
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Ad Campaigns Hub */}
        <Card className="group hover:shadow-md transition-shadow">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                <Megaphone className="h-6 w-6 text-purple-600 dark:text-purple-400" />
              </div>
              <Badge variant="secondary">{adCampaigns?.length || 0} campaigns</Badge>
            </div>
            <CardTitle className="mt-4">Ad Campaigns</CardTitle>
            <CardDescription>
              Facebook, Instagram, Google Ads with AI-powered creative optimization
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-4">
              {adCampaigns?.slice(0, 3).map((campaign) => (
                <div key={campaign.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">{campaign.campaign_name}</span>
                  <Badge variant={campaign.status === "active" ? "default" : "outline"} className="text-xs">
                    {campaign.platform}
                  </Badge>
                </div>
              ))}
              {(!adCampaigns || adCampaigns.length === 0) && (
                <p className="text-sm text-muted-foreground">No ad campaigns yet</p>
              )}
            </div>
            <Link href="/dashboard/campaigns/ads">
              <Button variant="outline" className="w-full gap-2 group-hover:bg-accent">
                Manage Ads
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* AI Video Hub */}
        <Card className="group hover:shadow-md transition-shadow">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-rose-100 dark:bg-rose-900/30">
                <Video className="h-6 w-6 text-rose-600 dark:text-rose-400" />
              </div>
              <Badge variant="secondary">AI-Powered</Badge>
            </div>
            <CardTitle className="mt-4">AI Video Studio</CardTitle>
            <CardDescription>
              Generate personalized video content for listings, market updates, and client outreach
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <PlayCircle className="h-4 w-4" />
                Listing videos with AI voiceover
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Market update videos
              </div>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                Personalized client videos
              </div>
            </div>
            <Link href="/dashboard/videos/create">
              <Button variant="outline" className="w-full gap-2 group-hover:bg-accent">
                Create Video
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* ROI Analytics Hub */}
        <Card className="group hover:shadow-md transition-shadow">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <BarChart3 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              </div>
              <Badge variant="secondary">Analytics</Badge>
            </div>
            <CardTitle className="mt-4">ROI Analytics</CardTitle>
            <CardDescription>
              Track campaign performance, attribution, and cost per lead across all channels
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <p className="text-xs text-muted-foreground">Total Spend</p>
                <p className="text-lg font-semibold">${totalAdSpend.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Impressions</p>
                <p className="text-lg font-semibold">{(totalImpressions / 1000).toFixed(1)}K</p>
              </div>
            </div>
            <Link href="/dashboard/campaigns/roi">
              <Button variant="outline" className="w-full gap-2 group-hover:bg-accent">
                View Analytics
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Content Repurpose Hub */}
        <Card className="group hover:shadow-md transition-shadow">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <RefreshCw className="h-6 w-6 text-amber-600 dark:text-amber-400" />
              </div>
              <Badge variant="secondary">AI-Powered</Badge>
            </div>
            <CardTitle className="mt-4">Content Repurpose</CardTitle>
            <CardDescription>
              Transform one piece of content into multi-channel assets with AI
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Video className="h-4 w-4" />
                Video to social posts
              </div>
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Blog to email series
              </div>
              <div className="flex items-center gap-2">
                <Megaphone className="h-4 w-4" />
                Listing to ad creatives
              </div>
            </div>
            <Link href="/dashboard/campaigns/repurpose">
              <Button variant="outline" className="w-full gap-2 group-hover:bg-accent">
                Repurpose Content
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Social Planner Hub */}
        <Card className="group hover:shadow-md transition-shadow">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-cyan-100 dark:bg-cyan-900/30">
                <Calendar className="h-6 w-6 text-cyan-600 dark:text-cyan-400" />
              </div>
              <Badge variant="secondary">Scheduler</Badge>
            </div>
            <CardTitle className="mt-4">Social Planner</CardTitle>
            <CardDescription>
              Schedule and automate your social media content calendar
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Visual content calendar
              </div>
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4" />
                Auto-post scheduling
              </div>
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Engagement analytics
              </div>
            </div>
            <Link href="/dashboard/social">
              <Button variant="outline" className="w-full gap-2 group-hover:bg-accent">
                Plan Content
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
