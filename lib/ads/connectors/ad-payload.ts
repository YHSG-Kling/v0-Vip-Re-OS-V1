/**
 * lib/ads/connectors/ad-payload.ts
 *
 * Wave 43 — assembles the EXACT parameter set each ad platform needs to actually
 * create an ad (campaign → ad set/group → creative → ad), and validates we have
 * everything BEFORE we call the provider. Used by both paths: the Ads Manager
 * auto-creating an ad, and a user creating one in the dashboard — both assemble
 * through here so the payload + the readiness rules are identical.
 *
 * REAL-ESTATE HARD RULE (release-blocker): Meta requires the HOUSING special ad
 * category for any housing ad (Fair Housing / Meta's 2019 settlement). That
 * category DISABLES targeting by age, gender, ZIP radius, and many interests — so
 * the validator both ENFORCES special_ad_categories=['HOUSING'] and REJECTS the
 * forbidden narrowing. Pure + fully unit-tested.
 */

export type AdObjective = "leads" | "traffic" | "awareness" | "conversions"

export interface AdCreativeSpec {
  headline:       string | null
  primaryText:    string | null
  description?:   string | null
  callToAction?:  string | null
  mediaAssetUrl?: string | null     // image/video from the Asset Manager
  destinationUrl?: string | null    // landing page (not needed if leadFormId)
}

export interface AdTargetingSpec {
  locations: Array<{ city?: string; state?: string; zip?: string; radiusMiles?: number }>
  ageMin?:   number
  ageMax?:   number
  genders?:  Array<"male" | "female">
  interests?: string[]
  audienceExternalId?: string | null   // a synced custom/lookalike audience to target
}

export interface AdBuildInput {
  platform:        "facebook" | "instagram" | "google"
  objective:       AdObjective
  campaignName:    string
  dailyBudgetUsd:  number
  pageId?:         string | null       // Meta page (from the connection)
  leadFormId?:     string | null       // Meta lead form (required for objective=leads)
  creative:        AdCreativeSpec
  targeting:       AdTargetingSpec
  /** Real estate is always HOUSING. Defaulted + enforced by the validator. */
  specialAdCategory?: "HOUSING" | "NONE"
}

export interface ValidationResult { ready: boolean; missing: string[]; violations: string[] }

const META_OBJECTIVE: Record<AdObjective, string> = {
  leads: "OUTCOME_LEADS", traffic: "OUTCOME_TRAFFIC", awareness: "OUTCOME_AWARENESS", conversions: "OUTCOME_SALES",
}

/**
 * Pure: do we have every provider-required parameter, and does the ad obey the
 * Housing rules? `missing` = required params absent; `violations` = present-but-
 * illegal (e.g. age narrowing under HOUSING). ready = both empty.
 */
export function validateAdReadiness(input: AdBuildInput): ValidationResult {
  const missing: string[] = []
  const violations: string[] = []
  const isMeta = input.platform === "facebook" || input.platform === "instagram"
  const category = input.specialAdCategory ?? "HOUSING"

  // Universal creative + budget requirements.
  if (!input.campaignName?.trim()) missing.push("campaignName")
  if (!(input.dailyBudgetUsd > 0)) missing.push("dailyBudgetUsd")
  if (!input.creative.headline?.trim()) missing.push("creative.headline")
  if (!input.creative.primaryText?.trim()) missing.push("creative.primaryText")
  if (!input.creative.mediaAssetUrl?.trim()) missing.push("creative.mediaAssetUrl")
  if ((input.targeting.locations ?? []).length === 0) missing.push("targeting.locations")

  if (isMeta) {
    // Lead ads need a page + a lead form; everything else needs a destination url.
    if (input.objective === "leads") {
      if (!input.pageId?.trim()) missing.push("pageId")
      if (!input.leadFormId?.trim()) missing.push("leadFormId")
    } else if (!input.creative.destinationUrl?.trim()) {
      missing.push("creative.destinationUrl")
    }
    // HOUSING enforcement (Fair Housing / Meta settlement).
    if (category !== "HOUSING") {
      violations.push("specialAdCategory must be HOUSING for real-estate ads")
    } else {
      if (input.targeting.ageMin != null && input.targeting.ageMin > 18) violations.push("HOUSING ads cannot narrow by age (ageMin must be 18)")
      if (input.targeting.ageMax != null && input.targeting.ageMax < 65) violations.push("HOUSING ads cannot narrow by age (ageMax must be 65+)")
      if ((input.targeting.genders ?? []).length > 0) violations.push("HOUSING ads cannot target by gender")
      if (input.targeting.locations.some((l) => (l.radiusMiles ?? 0) > 0 && (l.radiusMiles ?? 0) < 15)) violations.push("HOUSING ads cannot use a radius under 15 miles")
    }
  } else {
    // Google: every ad needs a final URL; responsive ads need real copy.
    if (!input.creative.destinationUrl?.trim()) missing.push("creative.destinationUrl")
  }

  return { ready: missing.length === 0 && violations.length === 0, missing, violations }
}

export interface MetaAdStructure { campaign: Record<string, unknown>; adSet: Record<string, unknown>; adCreative: Record<string, unknown>; ad: Record<string, unknown> }

/** Pure: build the Meta Marketing API objects (campaign → ad set → creative → ad). */
export function buildMetaAdStructure(input: AdBuildInput): MetaAdStructure {
  const budgetCents = Math.round(input.dailyBudgetUsd * 100)
  const cta = (input.creative.callToAction ?? "LEARN_MORE").toUpperCase()
  // HOUSING: broad age 18-65+, no gender; geo allowed but not tight radius.
  const targeting = {
    geo_locations: {
      cities: input.targeting.locations.filter((l) => l.city).map((l) => ({ name: l.city })),
      regions: input.targeting.locations.filter((l) => l.state && !l.city).map((l) => ({ name: l.state })),
    },
    age_min: 18, age_max: 65,
    ...(input.targeting.audienceExternalId ? { custom_audiences: [{ id: input.targeting.audienceExternalId }] } : {}),
  }
  const linkData = input.objective === "leads"
    ? { call_to_action: { type: cta, value: { lead_gen_form_id: input.leadFormId } }, message: input.creative.primaryText, name: input.creative.headline, description: input.creative.description ?? undefined }
    : { link: input.creative.destinationUrl, message: input.creative.primaryText, name: input.creative.headline, description: input.creative.description ?? undefined, call_to_action: { type: cta, value: { link: input.creative.destinationUrl } } }

  return {
    campaign: { name: input.campaignName, objective: META_OBJECTIVE[input.objective], special_ad_categories: ["HOUSING"], status: "PAUSED" },
    adSet: {
      name: `${input.campaignName} — Ad Set`, daily_budget: budgetCents,
      billing_event: "IMPRESSIONS",
      optimization_goal: input.objective === "leads" ? "LEAD_GENERATION" : "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      ...(input.objective === "leads" && input.pageId ? { promoted_object: { page_id: input.pageId } } : {}),
      targeting, status: "PAUSED",
    },
    adCreative: { name: `${input.campaignName} — Creative`, object_story_spec: { page_id: input.pageId, link_data: linkData } },
    ad: { name: `${input.campaignName} — Ad`, status: "PAUSED" },
  }
}

export interface GoogleAdStructure { budget: Record<string, unknown>; campaign: Record<string, unknown>; adGroup: Record<string, unknown>; ad: Record<string, unknown> }

/** Pure: build the Google Ads API objects (budget → campaign → ad group → responsive ad). */
export function buildGoogleAdStructure(input: AdBuildInput): GoogleAdStructure {
  const budgetMicros = Math.round(input.dailyBudgetUsd * 1_000_000)
  return {
    budget: { name: `${input.campaignName} — Budget`, amount_micros: budgetMicros, delivery_method: "STANDARD" },
    campaign: {
      name: input.campaignName, status: "PAUSED",
      advertising_channel_type: input.objective === "leads" ? "SEARCH" : "DISPLAY",
      maximize_conversions: {}, // bidding strategy
    },
    adGroup: { name: `${input.campaignName} — Ad Group`, status: "PAUSED", type: input.objective === "leads" ? "SEARCH_STANDARD" : "DISPLAY_STANDARD" },
    ad: {
      final_urls: [input.creative.destinationUrl],
      responsive_search_ad: {
        headlines: [input.creative.headline, "Local Real Estate Experts", "Your Move Starts Here"].filter(Boolean).map((t) => ({ text: t })),
        descriptions: [input.creative.primaryText, input.creative.description].filter(Boolean).map((t) => ({ text: t })),
      },
    },
  }
}

/** Build the right provider structure + its readiness in one call (used by both
 *  the Ads Manager and the user dashboard). */
export function assembleAd(input: AdBuildInput): { validation: ValidationResult; meta?: MetaAdStructure; google?: GoogleAdStructure } {
  const validation = validateAdReadiness(input)
  if (input.platform === "google") return { validation, google: buildGoogleAdStructure(input) }
  return { validation, meta: buildMetaAdStructure(input) }
}
