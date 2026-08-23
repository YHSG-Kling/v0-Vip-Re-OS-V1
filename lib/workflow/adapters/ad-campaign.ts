/**
 * Ad Campaign adapter — launches a Facebook, Google, Instagram, LinkedIn, or TikTok ad.
 * Uses lib/ads/ad-creator.ts with the correct two-arg signature.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const adCampaignAdapter: ChannelAdapter = {
  channel: "ad_campaign",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, agentUserId, previousOutputs } = ctx

    const platform = step.ad_platform
    if (!platform) {
      return { status: "error", providerKey: "ads", error: "No ad platform configured" }
    }

    if (!agentUserId) {
      return { status: "error", providerKey: "ads", error: "No agent user ID for ad campaign auth" }
    }

    // Resolve creative image from previous ai_image step output
    let imageUrl: string | undefined
    for (const output of Object.values(previousOutputs)) {
      if (output?.image_url) { imageUrl = String(output.image_url); break }
    }

    // Map generic platform names to supported platform values
    const platformMap: Record<string, "facebook" | "instagram" | "google" | "linkedin" | "tiktok"> = {
      facebook: "facebook",
      instagram: "instagram",
      google: "google",
      youtube: "google",  // YouTube ads go through Google Ads
      linkedin: "linkedin",
      tiktok: "tiktok",
    }
    const mappedPlatform = platformMap[platform] ?? "facebook"

    try {
      const { createAdCampaign } = await import("@/lib/ads/ad-creator")

      const result = await createAdCampaign(agentUserId, {
        brokerageId,
        agentUserId,
        campaignName: step.step_name ?? `Sequence Campaign — ${new Date().toLocaleDateString()}`,
        platform: mappedPlatform,
        objective: (step.ad_objective ?? "leads") as "awareness" | "traffic" | "leads" | "conversions",
        dailyBudget: step.ad_budget_cents ? step.ad_budget_cents / 100 : 50,
        targetingConfig: {
          age_min: 25,
          age_max: 65,
          locations: [],
          interests: step.ad_audience_prompt ? [step.ad_audience_prompt] : ["real estate", "homebuying"],
          custom_audience_ids: [],
          // An automation NEVER suppresses an audience on its own initiative:
          // exclusion is the regulated operation (Fair Housing / HUD v. Meta) and
          // it is an operator's declared decision, gated when they make it. `[]`
          // is stated rather than omitted so the field cannot be forgotten into
          // meaning something else later.
          excluded_audience_ids: [],
          lookalike_source_audience_id: null,
          income_percentile: "top_50",
          homeowner_status: "any",
        },
      })

      return {
        status: result.success ? "sent" : "error",
        providerKey: `ads-${mappedPlatform}`,
        messageId: result.campaignId,
        error: result.error,
        output: { campaign_id: result.campaignId, platform: mappedPlatform },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: "error", providerKey: "ads", error: msg }
    }
  },
}
