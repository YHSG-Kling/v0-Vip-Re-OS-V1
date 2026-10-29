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
  launchTvCampaign,
  CTV_TV_PLATFORMS,
  type CtvLaunchPackage,
  type CtvTargeting,
  type CtvTvPlatform,
  type TvLaunchResult,
} from "@/lib/ads/ctv-campaign"
import { requireAdsActor as requireActor } from "@/lib/auth/require-caller"

// TOMBSTONE: local requireActor merged onto lib/auth/require-caller.ts
// requireAdsActor (imported above as `requireActor`) — §1/§6 SAME BODY census
// round 3, 2026-09-09.

export async function stageCtvCampaignAction(input: {
  listingId?: string | null
  videoProjectId?: string | null
  /** Contract C5 (wave 145, lane 145D): the creative asset (ai_video_projects.id) and the APPROVED topic it is made
   *  from — the gateway refuses an unapproved topic. The tenant is never an input: it is the session's. */
  assetId?: string | null
  topicId?: string | null
  campaignName?: string
  dailyBudgetCents: number
  targeting: CtvTargeting
  /** Wave 146 (ruling 8): the TV connection — vibe_ctv (default), groundtruth or stackadapt — and the CPM bid the
   *  latter two need. The gateway validates both; the tenant is still the session's. */
  tvPlatform?: CtvTvPlatform | null
  bidCpmUsd?: number | null
}): Promise<{ success: boolean; error?: string; package?: CtvLaunchPackage }> {
  const { actor, error } = await requireActor()
  if (!actor) return { success: false, error }
  if (input.tvPlatform != null && !(CTV_TV_PLATFORMS as readonly string[]).includes(input.tvPlatform)) {
    return { success: false, error: `'${String(input.tvPlatform)}' is not a TV connection` }
  }

  // A TOPIC SPOT goes through the topic lane (wave 145, lane 145Z — lane 145G Outside-lane 1, contract C5): stageTopicTvSpot
  // checks the topic is approved FOR TV, the creative was made FROM it, runs the final personalization phase (contract C4)
  // and records it, calls this SAME gateway under ledger evidence, and claims the topic for the spot. Called directly, the
  // gateway would stage the spot without the final phase and without the topic claim.
  if (input.topicId) {
    const assetId = input.assetId ?? input.videoProjectId ?? null
    if (!assetId) return { success: false, error: "a TV spot from a topic needs the video made from that topic" }
    const { stageTopicTvSpot } = await import("@/lib/marketing/ctv-lane")
    const spot = await stageTopicTvSpot({
      brokerageId: actor.brokerageId, agentUserId: actor.userId, topicId: input.topicId, assetId,
      dailyBudgetCents: input.dailyBudgetCents, targeting: input.targeting, campaignName: input.campaignName,
      tvPlatform: input.tvPlatform ?? null, bidCpmUsd: input.bidCpmUsd ?? null,
    })
    if (!spot.ok) return { success: false, error: spot.reason }
    return { success: true, package: spot.package as CtvLaunchPackage | undefined }
  }

  return stageCtvCampaign({
    brokerageId: actor.brokerageId,
    agentUserId: actor.userId,
    listingId: input.listingId ?? null,
    videoProjectId: input.videoProjectId ?? null,
    assetId: input.assetId ?? null,
    topicId: input.topicId ?? null,
    campaignName: input.campaignName,
    dailyBudgetCents: input.dailyBudgetCents,
    targeting: input.targeting,
    tvPlatform: input.tvPlatform ?? null,
    bidCpmUsd: input.bidCpmUsd ?? null,
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
  if (!(CTV_TV_PLATFORMS as readonly string[]).includes(String(campaign.platform))) {
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

  const kernelEmit = await import("@/lib/kernel/emit")
  const { error: eventError } = kernelEmit.asWriteResult(await kernelEmit.emitKernelEvent({
    brokerageId: actor.brokerageId,
    entityType: "ad_campaign",
    entityId: campaignId,
    event: "ad_campaign_launched",
    actorUserId: actor.userId,
    metadata: {
      platform: campaign.platform,
      campaign_name: campaign.campaign_name,
      launched_via: campaign.platform === "vibe_ctv" ? "human_confirmation_vibe_dashboard" : `human_confirmation_${campaign.platform}_dashboard`,
    },
    auditOnly: true,
  }))
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
): Promise<TvLaunchResult | { dispatched: false; reason: string }> {
  const { actor, error } = await requireActor()
  if (!actor) return { dispatched: false, reason: error ?? "Not authenticated" }

  // Ownership check with the user-scoped client before touching the service path.
  const supabase = await createClient()
  const { data: campaign, error: fetchError } = await supabase
    .from("ad_campaigns")
    .select("id, platform")
    .eq("id", campaignId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (fetchError) return { dispatched: false, reason: fetchError.message }
  if (!campaign) return { dispatched: false, reason: "Campaign not found" }

  // Dispatch + flip-to-live + ledger live in ONE place, shared with the Ads
  // Manager executor (lib/ads/ctv-campaign.ts::launchCtvCampaignOnVibe). The
  // flip used to be re-spelled here; it moved onto the survivor (2026-09-07).
  if (campaign.platform === "vibe_ctv") {
    const r = await launchCtvCampaignOnVibe({
      campaignId: campaign.id as string,
      brokerageId: actor.brokerageId,
      actorUserId: actor.userId,
      launchedVia: "vibe_api",
    })
    return { dispatched: r.dispatched, reason: r.reason, externalCampaignId: r.vibeCampaignId, platform: "vibe_ctv" }
  }
  // Wave 146 (ruling 8): the two other TV connections (groundtruth / stackadapt) run
  // the SAME broadcast gate through the ad-connector registry — the one router
  // lib/ads/ctv-campaign.ts::launchTvCampaign flips the row only on the provider's word.
  return launchTvCampaign({
    campaignId: campaign.id as string,
    brokerageId: actor.brokerageId,
    actorUserId: actor.userId,
    launchedVia: "provider_api",
  })
}
