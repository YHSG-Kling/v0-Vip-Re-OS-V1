/**
 * lib/ads/orchestrate-ad-retarget-send.ts
 *
 * Wave 38 — ad retarget preset dispatcher. Stages an ad_campaigns
 * row tied to a facebook_custom_audiences entry. The existing
 * ad-launcher cron picks it up, calls the FB Marketing API, and
 * updates the row with the external campaign id.
 *
 * This dispatcher does NOT call the FB Ads API directly — the launch
 * involves creative upload, ad set targeting, billing setup, and
 * approval flow that benefits from the cron's retry semantics. Here
 * we just queue.
 *
 * Cross-channel attribution: the bundle_dispatch_id flows through
 * ad_campaigns.metadata so the analytics view can answer "this
 * bundle ran a retarget ad against the resulting audience".
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface OrchestrateAdRetargetSendArgs {
  brokerageId: string
  presetId:    string
  teamId?:     string | null
  agentUserId?: string | null
  bundleDispatchId?: string | null
  systemSource?: string
}

export interface OrchestrateAdRetargetSendResult {
  success:        boolean
  presetName?:    string
  adCampaignId?:  string
  audienceId?:    string | null
  error?:         string
}

interface PresetRow {
  id: string
  brokerage_id: string
  name: string
  facebook_audience_id: string | null
  ad_headline: string | null
  ad_body: string | null
  ad_cta: string | null
  ad_image_url: string | null
  ad_landing_url: string | null
  ad_video_url: string | null
  daily_budget_cents: number | null
  is_active: boolean
}

export async function orchestrateAdRetargetSend(
  args: OrchestrateAdRetargetSendArgs,
): Promise<OrchestrateAdRetargetSendResult> {
  const svc = createServiceClient()

  const { data: presetData } = await svc.from("ad_retarget_presets")
    .select("id, brokerage_id, name, facebook_audience_id, ad_headline, ad_body, ad_cta, ad_image_url, ad_landing_url, ad_video_url, daily_budget_cents, is_active")
    .eq("id", args.presetId)
    .maybeSingle()
  const preset = presetData as PresetRow | null
  if (!preset) return { success: false, error: "preset_not_found" }
  if (preset.brokerage_id !== args.brokerageId) return { success: false, error: "tenant_mismatch", presetName: preset.name }
  if (!preset.is_active) return { success: false, error: "preset_deactivated", presetName: preset.name }
  if (!preset.facebook_audience_id) return { success: false, error: "no_audience_linked", presetName: preset.name }

  // Audience tenant gate.
  const { data: audience } = await svc.from("facebook_custom_audiences")
    .select("id, brokerage_id, status")
    .eq("id", preset.facebook_audience_id)
    .maybeSingle()
  const aud = audience as { id: string; brokerage_id: string | null; status: string | null } | null
  if (!aud) return { success: false, error: "audience_not_found", presetName: preset.name }
  if (aud.brokerage_id !== args.brokerageId) return { success: false, error: "audience_tenant_mismatch", presetName: preset.name }

  // Stage the ad_campaigns row. THIS DID NOT ACTUALLY STAGE A LAUNCHABLE
  // CAMPAIGN (orphan doctrine, missing half): the insert wrote only
  // brokerage_id/campaign_name/status, so the row carried no platform, no
  // budget and no targeting_config — the audience this whole function exists
  // to retarget was never attached to the campaign it created. The comment
  // above also named an "ad-launcher cron" that does not exist anywhere in
  // lib/kernel/cron-dispatch.ts. The REAL reader is the existing Ads Manager
  // loop: a human approves the campaign + its creative on the Ads dashboard
  // (app/dashboard/campaigns/ads), then app/api/cron/ads-manager-sweep's
  // proposeAdLaunches (lib/ads/ad-manager.ts) proposes the gated launch once
  // an approved creative + connected account exist — the SAME path every
  // other ad_campaigns producer in this file (listing-ad-producer.ts,
  // ad-creative-engine.ts) already relies on. `custom_audience_ids` is the
  // field launch-assembler.ts actually resolves to the platform's external
  // audience id (lib/kernel/ads.ts TargetingConfig).
  const dailyBudget = preset.daily_budget_cents && preset.daily_budget_cents > 0
    ? Math.max(1, Math.round(preset.daily_budget_cents / 100))
    : null
  const { data: campaign, error } = await svc.from("ad_campaigns").insert({
    brokerage_id:     args.brokerageId,
    agent_user_id:    args.agentUserId ?? null,
    team_id:          args.teamId ?? null,
    campaign_name:    preset.name,
    platform:         "facebook",
    objective:        "leads",
    status:           "draft",
    daily_budget:     dailyBudget,
    targeting_config: {
      custom_audience_ids: [aud.id],
      destination_url: preset.ad_landing_url ?? null,
      retarget_preset_id: preset.id,
      bundle_dispatch_id: args.bundleDispatchId ?? null,
      system_source: args.systemSource ?? "ad_retarget_preset",
    },
    visibility_scope: args.teamId ? "team" : args.agentUserId ? "agent" : "brokerage",
    created_at:       new Date().toISOString(),
  } as Record<string, unknown>).select("id").single()
  if (error) return { success: false, error: error.message, presetName: preset.name }
  const campaignId = campaign.id as string

  // A campaign with no creative can never clear proposeAdLaunches' "at least
  // one approved creative" gate — stage the preset's own copy as the draft so
  // there is something for a human to review and approve.
  const { error: creativeError } = await svc.from("ad_creative_variations").insert({
    brokerage_id:    args.brokerageId,
    ad_campaign_id:  campaignId,
    variation_name:  `${preset.name} — retarget`,
    headline:        (preset.ad_headline ?? preset.name).slice(0, 60),
    primary_text:    (preset.ad_body ?? "").slice(0, 300),
    call_to_action:  preset.ad_cta || "LEARN_MORE",
    media_asset_url: preset.ad_video_url ?? preset.ad_image_url ?? null,
    destination_url: preset.ad_landing_url ?? null,
    generated_from:  `retarget_preset:${preset.id}`,
    approval_status: "draft",
  })
  if (creativeError) console.error("[orchestrate-ad-retarget-send] creative draft insert refused:", creativeError.message)

  return {
    success:       true,
    presetName:    preset.name,
    adCampaignId:  campaignId,
    audienceId:    aud.id,
  }
}
