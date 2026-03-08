// app/dashboard/campaigns/ads/page.tsx
// Layer 9.3 — Ads Management Page with Content Performance Predictor Widget

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AdsDashboardClient } from "./ads-dashboard-client"

export const metadata = {
  title: "Ad Campaigns | Dashboard",
  description: "Manage your ad campaigns and creative variations",
}

export default async function AdsCampaignsPage() {
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
    .select("id, brokerage_id, role, first_name, last_name")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    redirect("/onboarding")
  }

  // Get ad campaigns
  const { data: campaigns } = await supabase
    .from("ad_campaigns")
    .select(`
      *,
      marketing_campaigns (campaign_name),
      ad_creative_variations (*)
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(50)

  // Get ad performance data
  const campaignIds = campaigns?.map((c) => c.id) || []
  let performanceData: any[] = []

  if (campaignIds.length > 0) {
    const { data: performance } = await supabase
      .from("ad_performance")
      .select("*")
      .in("ad_campaign_id", campaignIds)
      .order("captured_at", { ascending: false })

    performanceData = performance || []
  }

  return (
    <AdsDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.role || "agent"}
      campaigns={campaigns || []}
      performanceData={performanceData}
    />
  )
}
