/**
 * lib/ads/launch-assembler.ts
 *
 * Wave 44 — the bridge from our data model to the provider ad payload at launch
 * time. Loads a campaign's approved creative + targeting + connected page/lead
 * form, and assembles the AdBuildInput that ad-payload.ts validates + turns into
 * the real Meta/Google objects. Used by the launch handler so an ad can't reach a
 * provider missing a required param (or violating Fair Housing).
 */
import { createServiceClient } from "@/lib/supabase/service"
import type { AdBuildInput, AdObjective } from "./connectors/ad-payload"
import { getConnector, loadConnectorCredential } from "./connectors/registry"
import { adCredentialPlatform } from "./connection-status"

export interface AssembleResult { ok: boolean; input?: AdBuildInput; error?: string }

/**
 * Build the provider AdBuildInput from a campaign: its newest APPROVED creative,
 * its targeting_config (locations + page_id + lead_form_id + audience), budget, and
 * objective. The connected ad-account/page come from targeting_config (set when the
 * campaign is created) + the platform connection.
 */
export async function assembleAdFromCampaign(
  campaignId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<AssembleResult> {
  const supabase = client ?? createServiceClient()

  const { data: c } = await supabase
    .from("ad_campaigns")
    .select("id, brokerage_id, platform, objective, campaign_name, daily_budget, targeting_config, status")
    .eq("id", campaignId).maybeSingle()
  const campaign = c as {
    id: string; brokerage_id: string; platform: string; objective: string; campaign_name: string
    daily_budget: number | null; targeting_config: Record<string, any> | null
  } | null
  if (!campaign) return { ok: false, error: "campaign not found" }

  // Newest approved creative for this campaign (the one the human released).
  const { data: cr } = await supabase
    .from("ad_creative_variations")
    .select("headline, primary_text, description, call_to_action, media_asset_url, destination_url")
    .eq("ad_campaign_id", campaignId).eq("approval_status", "approved")
    .order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (!cr) return { ok: false, error: "no approved creative" }
  const creative = cr as { headline: string | null; primary_text: string | null; description: string | null; call_to_action: string | null; media_asset_url: string | null; destination_url: string | null }

  const tc = campaign.targeting_config ?? {}
  const locations = Array.isArray(tc.locations) ? tc.locations : []

  const input: AdBuildInput = {
    platform:       campaign.platform as AdBuildInput["platform"],
    objective:      (campaign.objective as AdObjective) ?? "leads",
    campaignName:   campaign.campaign_name,
    dailyBudgetUsd: Number(campaign.daily_budget ?? 0),
    pageId:         (tc.page_id as string | null) ?? null,
    leadFormId:     (tc.lead_form_id as string | null) ?? null,
    creative: {
      headline:       creative.headline,
      primaryText:    creative.primary_text,
      description:    creative.description,
      callToAction:   creative.call_to_action,
      mediaAssetUrl:  creative.media_asset_url,
      destinationUrl: creative.destination_url,
    },
    targeting: {
      locations: locations.map((l: any) => ({ city: l.city, state: l.state, zip: l.zip, radiusMiles: l.radius_miles ?? l.radiusMiles })),
      audienceExternalId: (tc.audience_external_id as string | null) ?? null,
    },
    specialAdCategory: "HOUSING",
  }
  return { ok: true, input }
}

export interface PublishResult { published: number; failed: number }

/**
 * Publisher (async hop): for a brokerage's 'launching' campaigns that have an
 * assembled payload but no external id yet, call the connector to actually create
 * the PAUSED campaign on the platform and store the external id (status → live).
 * A provider failure keeps the campaign 'launching' and records the error (no fake
 * live state). Best-effort per campaign; credential-gated.
 */
export async function publishLaunchingCampaigns(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<PublishResult> {
  const supabase = client ?? createServiceClient()
  const { data: campaigns } = await supabase
    .from("ad_campaigns")
    .select("id, platform, targeting_config")
    .eq("brokerage_id", brokerageId).eq("status", "launching")
  const list = (campaigns ?? []) as Array<{ id: string; platform: string; targeting_config: Record<string, any> | null }>

  let published = 0, failed = 0
  const credCache = new Map<string, Awaited<ReturnType<typeof loadConnectorCredential>>>()
  for (const c of list) {
    const tc = c.targeting_config ?? {}
    if (tc.external_campaign_id) continue            // already published
    const structure = tc.assembled_ad as Record<string, unknown> | undefined
    if (!structure) continue                          // not assembled (shouldn't happen post-launch gate)
    const platform = adCredentialPlatform(c.platform)
    const connector = getConnector(c.platform)
    if (!connector) { failed++; continue }
    if (!credCache.has(platform)) credCache.set(platform, await loadConnectorCredential(brokerageId, platform, supabase))
    const cred = credCache.get(platform)
    if (!cred) { failed++; continue }

    const res = await connector.publishCampaign({ structure, cred })
    if (res.ok) {
      await supabase.from("ad_campaigns").update({
        status: "live",
        targeting_config: { ...tc, external_campaign_id: res.externalCampaignId ?? null, last_publish_error: null },
      }).eq("id", c.id)
      published++
    } else {
      await supabase.from("ad_campaigns").update({
        targeting_config: { ...tc, last_publish_error: res.error ?? "publish failed" },
      }).eq("id", c.id)
      failed++
    }
  }
  return { published, failed }
}
