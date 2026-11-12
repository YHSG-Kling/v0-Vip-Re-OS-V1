// app/dashboard/campaigns/roi/page.tsx
// Layer 9.12 — Campaign ROI Dashboard Page

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ROIDashboardClient } from "./roi-dashboard-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { resolveEgressScopeForViewer } from "@/lib/kernel/egress-scope"
import { createServiceClient } from "@/lib/supabase/service"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import {
  getCampaignROIData,
  getChannelPerformanceData,
  getTopCampaigns,
} from "@/lib/campaigns/roi-calculator"
import { loadRoiOutcomeLedger, roiOutcomeCsv } from "@/lib/intelligence/roi-ledger"
import { DEFAULT_ROI_WINDOW, isRoiWindowKey, resolveRoiWindow } from "./roi-window"

export const metadata = {
  title: "Campaign ROI | Dashboard",
  description: "Track and analyze your marketing campaign ROI performance",
}

export default async function CampaignROIPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>
}) {
  const supabase = await createClient()
  const { window: windowParam } = await searchParams

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

  // Wave 142 (lane 142H): the window is the client's "Date Window" choice, carried in ?window= — before,
  // the select set state nothing read while this page always fetched the current month. Unknown → default.
  const roiWindow = resolveRoiWindow(isRoiWindowKey(windowParam) ? windowParam : DEFAULT_ROI_WINDOW)
  const windowStart = roiWindow.start
  const windowEnd = roiWindow.end

  // Fetch ROI data in parallel. Wave 152 (lane 152B): THE authorized ROI outcome reader runs beside the cache reads —
  // the SESSION's own ids (user.id + the profile's brokerage), the service client, and the reader itself is the gate
  // (scope from the hierarchy / team roster, commission dollars only for the finance roster, a team's lead or a solo
  // subscriber). Its campaign list is also the visibility filter for the cache rows below.
  const [roiResult, channelResult, topCampaignsResult, outcomes] = await Promise.all([
    getCampaignROIData(profile.brokerage_id, user.id),
    getChannelPerformanceData(profile.brokerage_id, user.id, windowStart, windowEnd),
    getTopCampaigns(profile.brokerage_id, user.id, 5),
    loadRoiOutcomeLedger(createServiceClient(), { userId: user.id, brokerageId: profile.brokerage_id }, { sinceDay: windowStart, untilDay: windowEnd }),
  ])
  // SERVER-ENFORCED VISIBILITY. campaign_roi is read brokerage-wide by the cache reader; only the campaigns the
  // authorized reader admits for THIS viewer reach the page, and a viewer whose scope could not be resolved sees
  // none (fail closed — "nobody checked" never renders as the whole brokerage). Revenue columns are withheld when
  // commission is off this viewer's display (CLAUDE.md §5).
  const inView = outcomes.ok ? new Set(outcomes.ledger.campaigns.map((c) => c.campaignId)) : new Set<string>()
  const moneyVisible = outcomes.ok && outcomes.ledger.scope.moneyVisible
  const scopeRows = (rows: any[]) => rows
    .filter((r) => inView.has(r.marketing_campaign_id))
    .map((r) => (moneyVisible ? r : { ...r, total_revenue: null, roi_percentage: null }))
  const scopedCampaigns = roiResult.success ? scopeRows(roiResult.campaigns || []) : []
  const scopedTop = topCampaignsResult.success && moneyVisible ? scopeRows(topCampaignsResult.campaigns || []) : []
  // Channel rows are TENANT-wide rollups: a narrower view sees its own campaigns in the outcomes tab instead.
  const channelVisible = outcomes.ok && outcomes.ledger.scope.kind === "tenant"
  const channels = channelVisible && channelResult.success
    ? (channelResult.channels || []).map((c: any) => (moneyVisible ? c : { ...c, revenue: null, roi_percentage: null }))
    : []

  // Get agents for the filter dropdown. Lane 90A (89D P1-5): the scope is the
  // ONE resolver (lib/kernel/egress-scope.ts) — broker / owner / admin /
  // compliance → the brokerage's people, team_lead → THEIR TEAM ("teams see
  // only their own board", CLAUDE.md §4), everyone else → no dropdown. The
  // `user_type === "broker" || "admin"` literal it replaces gave a broker OWNER
  // and a broker admin no dropdown at all; the seat roster in the `.in()` is
  // derived from TENANT_ADMIN_USER_TYPES rather than retyped.
  let agents: any[] = []
  // Wave 150 (lane 150DAC, C34): on a multi-location tenant the scope is the hierarchy's (an office head sees
  // their offices' people, never the whole house because of a user_type); single-office keeps the ladder.
  // Ids from the SESSION above; the reader fails closed to own work.
  const { scope } = await resolveEgressScopeForViewer(createServiceClient(), {
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
    if (scope.kind === "team" && scope.teamId) peopleQuery = peopleQuery.in("team_id", scope.teamIds?.length ? scope.teamIds : [scope.teamId])
    if (scope.kind === "location" && scope.locationId) peopleQuery = peopleQuery.in("location_id", scope.locationIds?.length ? scope.locationIds : [scope.locationId])
    const { data: agentData, error: agentError } = await peopleQuery
    if (agentError) console.error("[campaigns/roi] people read refused:", agentError.message)

    agents = agentData || []
  }

  return (
    <ROIDashboardClient
      userId={user.id}
      brokerageId={profile.brokerage_id}
      userRole={profile.user_type || "agent"}
      campaigns={scopedCampaigns}
      summary={roiResult.success ? roiResult.summary ?? null : null}
      channelPerformance={channels}
      topCampaigns={scopedTop}
      agents={agents}
      window={roiWindow.key}
      accessError={!roiResult.success ? roiResult.error : undefined}
      outcomes={outcomes.ok ? outcomes.ledger : null}
      outcomesError={outcomes.ok ? null : outcomes.error}
      outcomesCsv={outcomes.ok ? roiOutcomeCsv(outcomes.ledger) : null}
    />
  )
}
