// app/dashboard/campaigns/ads/page.tsx
// Layer 9.5 — Ads Management Page with Campaigns, Audiences, and Performance Tabs

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AdsDashboardClient } from "./ads-dashboard-client"
import { getAdConnections } from "@/lib/ads/connection-status"
import { listAudienceTemplates } from "@/app/actions/fb-audience-templates"
import { isVibeConfigured } from "@/lib/providers/vibe"
import type { CtvEligibleVideo } from "./ctv-lane"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-pipeline-reaper-policy"

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


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
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

  // Ad-account connection status (drives the Connect card + the launch gate).
  const adConnections = await getAdConnections(profile.brokerage_id)

  // Prebuilt one-click audience templates (static catalog) surfaced as a
  // gallery in the Audiences tab — agents pick a template to pre-fill the
  // Create Audience dialog.
  const audienceTemplates = await listAudienceTemplates()

  // ── Streaming-TV lane (Vibe.co) ──────────────────────────────────────────
  // TV-eligible creative: completed videos, 15-35s, with a rendered URL. The
  // stage action re-validates (incl. 16:9) — this is the picker's shortlist.
  const { data: ctvVideos } = await supabase
    .from("ai_video_projects")
    .select("id, title, video_url, duration_seconds, format, thumbnail_url, listing_id, created_at")
    .eq("brokerage_id", profile.brokerage_id)
    // Any finished asset can back a TV/streaming creative, not only `completed`.
    .in("status", VIDEO_FINISHED_STATUSES as unknown as string[])
    .not("video_url", "is", null)
    .gte("duration_seconds", 15)
    .lte("duration_seconds", 35)
    .order("created_at", { ascending: false })
    .limit(24)

  // Honest connection posture for the Vibe connector slot (never throws).
  const vibeConnected = await isVibeConfigured(profile.brokerage_id)

  return (
    <AdsDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.user_type || "agent"}
      agentName={agentName}
      campaigns={campaigns || []}
      performanceData={performanceData}
      audiences={audiences || []}
      adConnections={adConnections}
      audienceTemplates={audienceTemplates}
      vibeConnected={vibeConnected}
      ctvEligibleVideos={(ctvVideos || []) as CtvEligibleVideo[]}
    />
  )
}
