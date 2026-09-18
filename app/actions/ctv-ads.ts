"use server"

// app/actions/ctv-ads.ts
// Server actions for the Streaming-TV (CTV / Vibe.co) ad lane.
// Thin, session-authenticated wrappers over lib/ads/ctv-campaign.ts (stage) and
// lib/providers/vibe.ts (the honest connector slot). No simulated launches:
// status moves draft → live ONLY through the human mark-as-launched action.

import { createClient } from "@/lib/supabase/server"
import {
  stageCtvCampaign,
  launchCtvCampaignOnVibe,
  type CtvLaunchPackage,
  type CtvTargeting,
} from "@/lib/ads/ctv-campaign"
import type { CtvDispatchResult } from "@/lib/providers/vibe"
import { requireAdsActor as requireActor } from "@/lib/auth/require-caller"

// TOMBSTONE: local requireActor merged onto lib/auth/require-caller.ts
// requireAdsActor (imported above as `requireActor`) — §1/§6 SAME BODY census
// round 3, 2026-09-09.

export async function stageCtvCampaignAction(input: {
  listingId?: string | null
  videoProjectId?: string | null
  campaignName?: string
  dailyBudgetCents: number
  targeting: CtvTargeting
}): Promise<{ success: boolean; error?: string; package?: CtvLaunchPackage }> {
  const { actor, error } = await requireActor()
  if (!actor) return { success: false, error }

  return stageCtvCampaign({
    brokerageId: actor.brokerageId,
    agentUserId: actor.userId,
    listingId: input.listingId ?? null,
    videoProjectId: input.videoProjectId ?? null,
    campaignName: input.campaignName,
    dailyBudgetCents: input.dailyBudgetCents,
    targeting: input.targeting,
  })
}

/**
 * Human confirmation that the campaign was actually launched on vibe.co.
 * draft → 'live' — the same status the social lane's publisher writes after a
 * provider-confirmed launch (lib/ads/launch-assembler.ts), so the existing
 * status vocabulary is unchanged. This is the ONLY way a vibe_ctv campaign
 * leaves draft today.
 */
export async function markCtvCampaignLaunchedAction(
  campaignId: string,
): Promise<{ success: boolean; error?: string }> {
  const { actor, error } = await requireActor()
  if (!actor) return { success: false, error }

  const supabase = await createClient()
  const { data: campaign, error: fetchError } = await supabase
    .from("ad_campaigns")
    .select("id, platform, status, campaign_name")
    .eq("id", campaignId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (fetchError) return { success: false, error: fetchError.message }
  if (!campaign) return { success: false, error: "Campaign not found" }
  if (campaign.platform !== "vibe_ctv") {
    return { success: false, error: "Not a streaming-TV campaign" }
  }
  if (campaign.status !== "draft") {
    return { success: false, error: `Campaign status is '${campaign.status}', only drafts can be marked launched` }
  }

  const { error: updateError } = await supabase
    .from("ad_campaigns")
    .update({ status: "live", updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("brokerage_id", actor.brokerageId)
  if (updateError) return { success: false, error: updateError.message }

  const { error: eventError } = await supabase.from("lifecycle_events").insert({
    brokerage_id: actor.brokerageId,
    entity_type: "ad_campaign",
    entity_id: campaignId,
    event_type: "ad_campaign_launched",
    actor_user_id: actor.userId,
    metadata: {
      platform: "vibe_ctv",
      campaign_name: campaign.campaign_name,
      launched_via: "human_confirmation_vibe_dashboard",
    },
  })
  // Status change succeeded; a ledger failure is reported, not rolled back.
  if (eventError) {
    return { success: true, error: `Launched, but lifecycle event failed to record: ${eventError.message}` }
  }
  return { success: true }
}

/**
 * Dispatch a staged CTV campaign to Vibe end-to-end (advertiser → upload video
 * creative → create campaign → strategy + geo targeting → PUBLISH). Honest:
 * dispatched:true ONLY on a Vibe-confirmed PUBLISHED campaign — and only then is
 * the row flipped to 'live' with the Vibe ids recorded. On any failure the row
 * is untouched and the real reason is returned (the human-finalize path stays).
 */
export async function dispatchCtvCampaignAction(
  campaignId: string,
): Promise<CtvDispatchResult | { dispatched: false; reason: string }> {
  const { actor, error } = await requireActor()
  if (!actor) return { dispatched: false, reason: error ?? "Not authenticated" }

  // Ownership check with the user-scoped client before touching the service path.
  const supabase = await createClient()
  const { data: campaign, error: fetchError } = await supabase
    .from("ad_campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (fetchError) return { dispatched: false, reason: fetchError.message }
  if (!campaign) return { dispatched: false, reason: "Campaign not found" }

  // Dispatch + flip-to-live + ledger live in ONE place, shared with the Ads
  // Manager executor (lib/ads/ctv-campaign.ts::launchCtvCampaignOnVibe). The
  // flip used to be re-spelled here; it moved onto the survivor (2026-09-07).
  return launchCtvCampaignOnVibe({
    campaignId: campaign.id as string,
    brokerageId: actor.brokerageId,
    actorUserId: actor.userId,
    launchedVia: "vibe_api",
  })
}
