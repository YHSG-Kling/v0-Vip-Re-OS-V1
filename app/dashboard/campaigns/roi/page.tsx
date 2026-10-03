// app/dashboard/campaigns/roi/page.tsx
// Layer 9.12 — Campaign ROI Dashboard Page

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ROIDashboardClient } from "./roi-dashboard-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { resolveEgressScope } from "@/lib/kernel/egress-scope"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
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


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user profile with brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, team_id, user_type, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    redirect("/dashboard/onboarding")
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

  // Get agents for the filter dropdown. Lane 90A (89D P1-5): the scope is the
  // ONE resolver (lib/kernel/egress-scope.ts) — broker / owner / admin /
  // compliance → the brokerage's people, team_lead → THEIR TEAM ("teams see
  // only their own board", CLAUDE.md §4), everyone else → no dropdown. The
  // `user_type === "broker" || "admin"` literal it replaces gave a broker OWNER
  // and a broker admin no dropdown at all; the seat roster in the `.in()` is
  // derived from TENANT_ADMIN_USER_TYPES rather than retyped.
  let agents: any[] = []
  const scope = resolveEgressScope({
    userType: profile.user_type ?? "agent",
    userId: user.id,
    brokerageId: profile.brokerage_id,
    teamId: profile.team_id,
  })
  if (scope.kind !== "agent") {
    let peopleQuery = supabase
      .from("users")
      .select("id, first_name, last_name")
      .eq("brokerage_id", profile.brokerage_id)
      .in("user_type", ["agent", ...TENANT_ADMIN_USER_TYPES])
      .order("first_name")
    if (scope.kind === "team" && scope.teamId) peopleQuery = peopleQuery.eq("team_id", scope.teamId)
    const { data: agentData, error: agentError } = await peopleQuery
    if (agentError) console.error("[campaigns/roi] people read refused:", agentError.message)

    agents = agentData || []
  }

  return (
    <ROIDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.user_type || "agent"}
      campaigns={roiResult.success ? roiResult.campaigns || [] : []}
      summary={roiResult.success ? roiResult.summary ?? null : null}
      channelPerformance={channelResult.success ? channelResult.channels || [] : []}
      topCampaigns={topCampaignsResult.success ? topCampaignsResult.campaigns || [] : []}
      agents={agents}
      accessError={!roiResult.success ? roiResult.error : undefined}
    />
  )
}
