// app/dashboard/campaigns/ads/page.tsx
// Layer 9.5 — Ads Management Page with Campaigns, Audiences, and Performance Tabs

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AdsDashboardClient } from "./ads-dashboard-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Ad Campaigns | Dashboard",
  description: "Manage your ad campaigns, audiences, and creative variations",
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
    .select("id, brokerage_id, user_type, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Get ad campaigns with creatives
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

  // Get campaign IDs for performance query
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

  // Get Facebook custom audiences with latest sync runs
  const { data: audiences } = await supabase
    .from("facebook_custom_audiences")
    .select(`
      *,
      audience_sync_runs (
        id,
        run_status,
        records_synced,
        records_rejected,
        completed_at
      )
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(50)

  // Get agent name for creative generation context
  const agentName = `${profile.first_name || ""} ${profile.last_name || ""}`.trim()

  return (
    <AdsDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.user_type || "agent"}
      agentName={agentName}
      campaigns={campaigns || []}
      performanceData={performanceData}
      audiences={audiences || []}
    />
  )
}
