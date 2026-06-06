// lib/ads/ad-creator-types.ts
// Types extracted from ad-creator.ts so the latter can be a clean
// "use server" file (Next 16 / Turbopack only allows async function
// exports in "use server" modules — type exports are rejected).

export interface TargetingConfig {
  age_min: number
  age_max: number
  locations: Array<{ city: string; state: string; radius_miles: number }>
  interests: string[]
  custom_audience_ids: string[]
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
