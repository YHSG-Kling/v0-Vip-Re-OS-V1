// lib/ads/ad-creator-types.ts
// Types extracted from ad-creator.ts so the latter can be a clean
// "use server" file (Next 16 / Turbopack only allows async function
// exports in "use server" modules — type exports are rejected).

/**
 * The ad-creator door's targeting shape. A STRICTER spelling of
 * `TargetingConfig` in lib/kernel/ads.ts (every field required here, all
 * optional there) over the same `ad_campaigns.targeting_config` jsonb; the
 * kernel one is the governing definition and carries the field documentation.
 * The two spellings are a §6 finding this lane REPORTS rather than merges —
 * merging them changes every caller of `createAdCampaign` and belongs in its
 * own change.
 */
export interface TargetingConfig {
  age_min: number
  age_max: number
  locations: Array<{ city: string; state: string; radius_miles: number }>
  interests: string[]
  /** Audiences to TARGET. Read at launch by lib/ads/launch-assembler.ts. */
  custom_audience_ids: string[]
  /**
   * Audiences to SUPPRESS — `facebook_custom_audiences.id` values.
   *
   * REQUIRED, not optional, and that is the point (owner: "capability is vital
   * to this os to have not exclude"). A writer here must say what it suppresses,
   * even when the answer is `[]`. Every id in it is gated at this door
   * (lib/ads/ad-creator.ts step 1b) and again at launch: a
   * protected-characteristic persona audience may not be a suppression list on a
   * housing ad. Before this field existed, an operator did that in Meta's own
   * Exclude box, where this product could not see it.
   */
  excluded_audience_ids: string[]
  lookalike_source_audience_id: string | null
  income_percentile: "top_25" | "top_50" | "any"
  homeowner_status: "renter" | "owner" | "any"
}

export interface CreateAdCampaignParams {
  brokerageId: string
  agentUserId: string
  marketingCampaignId?: string
  campaignName: string
  platform: "facebook" | "instagram" | "google" | "linkedin" | "tiktok"
  objective: "awareness" | "traffic" | "leads" | "conversions"
  dailyBudget?: number
  lifetimeBudget?: number
  startDate?: string
  endDate?: string
  targetingConfig: TargetingConfig
}

export interface GenerateAdCreativeParams {
  adCampaignId: string
  context: {
    listingAddress?: string
    listingPrice?: number
    agentName?: string
    brokerageId: string
  }
}

export interface AdCreativeVariation {
  variationName: string
  headline: string
  primaryText: string
  description: string
  callToAction: string
}
