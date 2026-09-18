import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { CompetitiveMonitorClient } from "./competitive-monitor-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import {
  getCompetitorAds,
  getCompetitorPosts,
  getAdInsights,
  getTrendAlerts,
} from "@/lib/ads/ad-monitor"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Competitive Monitor | Dashboard",
  description: "Monitor competitor ads and posts with AI-powered insights",
}

export default async function CompetitiveMonitorPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user's brokerage_id
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  const brokerageId = userData.brokerage_id

  // Fetch initial data
  const [adsResult, postsResult, insightsResult, alertsResult] = await Promise.all([
    getCompetitorAds(brokerageId),
    getCompetitorPosts(brokerageId),
    getAdInsights(brokerageId),
    getTrendAlerts(brokerageId),
  ])

  return (
    <div className="flex-1 space-y-6 p-6 md:p-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Competitive Monitor</h1>
        <p className="text-muted-foreground">
          Track competitor ads and posts, analyze trends, and get AI-powered recommendations
        </p>
      </div>

      <CompetitiveMonitorClient
        brokerageId={brokerageId}
        initialAds={adsResult.ads || []}
        initialPosts={postsResult.posts || []}
        initialInsights={insightsResult.insights || []}
        initialAlerts={alertsResult.alerts || []}
      />
    </div>
  )
}
