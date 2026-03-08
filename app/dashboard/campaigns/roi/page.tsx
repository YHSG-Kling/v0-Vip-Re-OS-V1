// app/dashboard/campaigns/roi/page.tsx
// Layer 9.12 — Campaign ROI Dashboard Page

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ROIDashboardClient } from "./roi-dashboard-client"
import {
  getCampaignROIData,
  getChannelPerformanceData,
  getTopCampaigns,
} from "@/lib/campaigns/roi-calculator"

export const metadata = {
  title: "Campaign ROI | Dashboard",
  description: "Track and analyze your marketing campaign ROI performance",
}

export default async function CampaignROIPage() {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, team_id, role, first_name, last_name")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    redirect("/onboarding")
  }

  // Get current month date range
  const now = new Date()
  const windowStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10)
  const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10)

  // Fetch ROI data in parallel
  const [roiResult, channelResult, topCampaignsResult] = await Promise.all([
    getCampaignROIData(profile.brokerage_id, user.id),
    getChannelPerformanceData(profile.brokerage_id, user.id, windowStart, windowEnd),
    getTopCampaigns(profile.brokerage_id, user.id, 5),
  ])

  // Get agents for filter dropdown (if broker/admin)
  let agents: any[] = []
  if (profile.role === "broker" || profile.role === "admin") {
    const { data: agentData } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .eq("brokerage_id", profile.brokerage_id)
      .in("role", ["agent", "broker", "admin"])
      .order("first_name")

    agents = agentData || []
  }

  return (
    <ROIDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.role || "agent"}
      campaigns={roiResult.success ? roiResult.campaigns || [] : []}
      summary={roiResult.success ? roiResult.summary : null}
      channelPerformance={channelResult.success ? channelResult.channels || [] : []}
      topCampaigns={topCampaignsResult.success ? topCampaignsResult.campaigns || [] : []}
      agents={agents}
      accessError={!roiResult.success ? roiResult.error : undefined}
    />
  )
}
