// lib/kernel/lookalike-audience.ts
//
// LOOKALIKE FROM THE CLOSING TABLE — the Ads Manager's first-party superpower. Every
// competitor targets generic "homebuyer" interest segments. We have something they
// don't: the brokerage's ACTUAL closings. Each closed buyer is a proven conversion;
// the Ads Manager seeds a lookalike audience from the closing table (who really bought,
// where) so paid spend chases people like the ones who already said yes — staged as a
// draft ad campaign for the human to approve. NOT server-only.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** A seed needs at least this many closings to be a meaningful lookalike base. */
export const MIN_SEED = 5

// ─── WAVE 142 (lane 142D): THE AD-POLICY VERDICT, AS DATA — AND COMPLIANT LOOK-ALIKE RESEARCH ─────────
// Owner, verbatim: "Look-alike audiences (recent buyers / new listings / just-sold) for compliant marketing
// research — never assume look-alike targeting is lawful; respect consent, fair housing, protected
// characteristics and platform ad policies; where restricted, use for compliant content planning."
// Housing is a Special Ad Category on Meta and a restricted vertical on Google: the platforms offer NO
// look-alike / similar-audience model for housing ads, and the Fair Housing Act forbids targeting on a
// protected characteristic. So (1) the closing-table seed stays a LOCATION seed — a radius-limited, allowed
// housing input the human still approves on the DRAFT; it is never sent to a platform as a look-alike
// model; and (2) the RESEARCH below reads ONLY property / behaviour facts the tenant already holds on its
// OWN contacts (consented, already bought) and answers "what do the people who said yes have in common"
// for CONTENT PLANNING — topics and hooks, never a targeting segment. Versium's REACH MCP excludes
// look-alike list generation (lib/external/versium-client.ts VERSIUM_REACH_MCP), so no provider call exists
// to tempt a second path.
export const LOOKALIKE_AD_POLICY = Object.freeze({
  housing_special_ad_category: true,
  lookalike_model_available_for_housing: false,
  allowed_targeting_inputs: ["location"] as const,
  research_use: "content_planning" as const,
  summary: "housing ads: no platform look-alike model and no protected-characteristic targeting — the seed is a location input the human approves; the research feeds content planning only",
})

/** The attributes a compliant look-alike RESEARCH may read — property / behaviour facts, never a protected class. */
export const LOOKALIKE_RESEARCH_ATTRIBUTES = ["home_owner_status", "household_income", "occupation", "city", "online_presence_real_estate", "investing_real_estate", "home_improvement_interest", "length_of_residence"] as const
export type LookalikeResearchAttribute = (typeof LOOKALIKE_RESEARCH_ATTRIBUTES)[number]
/** A profile key naming a protected characteristic (or an age band) — never read, even if the caller passes it. */
const PROTECTED_RESEARCH_KEY = /age|dob|birth|gender|sex|ethnic|race|religio|language|national|familial|children|marital|disab|veteran|party|politic/i

export interface LookalikeResearchDenominator { attribute: LookalikeResearchAttribute; value: string; share: number; count: number }
export interface LookalikeResearch {
  seedCount: number
  /** The common denominators — attribute values at or above `minShare` of the seed, strongest first. */
  denominators: LookalikeResearchDenominator[]
  use: typeof LOOKALIKE_AD_POLICY.research_use
  /** Always null: a research result is not a targeting spec. */
  targeting: null
  policy: string
}

/**
 * PURE — the common denominators of a seed of profiles (closed buyers / just-sold sellers / new listings'
 * sellers), over the allow-listed attributes only. Null below MIN_SEED. A value is a denominator when at
 * least `minShare` (default 40%) of the seed carries it; income is BANDED so no figure leaves.
 */
export function researchLookalikeDenominators(
  seedProfiles: ReadonlyArray<Record<string, unknown>>,
  opts: { minSeed?: number; minShare?: number } = {},
): LookalikeResearch | null {
  const minSeed = opts.minSeed ?? MIN_SEED
  const minShare = opts.minShare ?? 0.4
  const seedCount = seedProfiles.length
  if (seedCount < minSeed) return null
  const band = (v: unknown): string | null => {
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, ""))
    if (!Number.isFinite(n) || n <= 0) return typeof v === "string" && /\$|-/.test(v) ? v.trim() : null
    return n < 50_000 ? "< $50k" : n < 100_000 ? "$50k–$100k" : n < 150_000 ? "$100k–$150k" : n < 250_000 ? "$150k–$250k" : "$250k+"
  }
  const tally = new Map<string, { attribute: LookalikeResearchAttribute; value: string; count: number }>()
  for (const p of seedProfiles) {
    for (const attribute of LOOKALIKE_RESEARCH_ATTRIBUTES) {
      if (PROTECTED_RESEARCH_KEY.test(attribute)) continue
      const raw = p[attribute]
      if (raw === undefined || raw === null || raw === "") continue
      const value = attribute === "household_income" ? band(raw) : typeof raw === "boolean" ? (raw ? "yes" : "no") : String(raw).trim()
      if (!value) continue
      const key = `${attribute}=${value}`
      const t = tally.get(key) ?? { attribute, value, count: 0 }
      t.count += 1
      tally.set(key, t)
    }
  }
  const denominators = [...tally.values()]
    .map((t) => ({ ...t, share: Math.round((t.count / seedCount) * 100) / 100 }))
    .filter((t) => t.share >= minShare)
    .sort((a, b) => b.share - a.share || a.attribute.localeCompare(b.attribute))
  return { seedCount, denominators, use: LOOKALIKE_AD_POLICY.research_use, targeting: null, policy: LOOKALIKE_AD_POLICY.summary }
}

export interface ClosingSeed { seedCount: number; cities: string[] }

/** Pure: the lookalike ad spec from the closing-table seed. Null when the seed is too
 *  thin (a 2-closing lookalike is noise, not signal). Wave 142: the spec names the policy it
 *  runs under — a LOCATION seed, never a platform look-alike model (LOOKALIKE_AD_POLICY). */
export function composeLookalike(seed: ClosingSeed): { name: string; targeting: Record<string, unknown> } | null {
  if (seed.seedCount < MIN_SEED) return null
  return {
    name: `Lookalike — ${seed.seedCount} past buyers`,
    targeting: {
      audience: "lookalike", seed_source: "closing_table", seed_count: seed.seedCount,
      locations: seed.cities.slice(0, 10),
      policy: LOOKALIKE_AD_POLICY.summary,
      lookalike_model: "not_available_for_housing",
    },
  }
}

export interface LookalikeResult { seedCount: number; staged: boolean; reason?: string }

/**
 * Build the closing-table seed for a brokerage and stage (draft) a lookalike ad
 * campaign. Idempotent per week (campaign_name keyed). Nothing launches.
 */
export async function runLookalikeAudience(
  brokerageId: string, opts: { now?: Date } = {}, client?: Svc,
): Promise<LookalikeResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()

  // The closing table — closed deals with a buyer + their listing's city.
  const { data: closed } = await supabase.from("transactions")
    .select("buyer_contact_id, listing_id").eq("brokerage_id", brokerageId)
    .eq("status", "closed").not("buyer_contact_id", "is", null).limit(2000)
  const rows = (closed ?? []) as Array<{ buyer_contact_id: string; listing_id: string | null }>
  const buyers = new Set(rows.map((r) => r.buyer_contact_id))
  const listingIds = Array.from(new Set(rows.map((r) => r.listing_id).filter((x): x is string => !!x)))

  let cities: string[] = []
  if (listingIds.length > 0) {
    const { data: ls } = await supabase.from("listings").select("city").in("id", listingIds.slice(0, 500))
    cities = Array.from(new Set(((ls ?? []) as any[]).map((l) => l.city).filter(Boolean)))
  }

  const spec = composeLookalike({ seedCount: buyers.size, cities })
  if (!spec) return { seedCount: buyers.size, staged: false, reason: `seed too thin (${buyers.size} < ${MIN_SEED})` }

  // Wave 142 (lane 142D): the compliant RESEARCH beside the location seed — the closed buyers' own
  // allow-listed facts (first-class contact columns the enrichment rail already filled), banded, read
  // under the tenant. A refused read leaves the research null; the draft still stages.
  let research: LookalikeResearch | null = null
  {
    const { data: seedRows, error: seedError } = await supabase.from("contacts")
      .select("home_owner_status, household_income, occupation, city")
      .eq("brokerage_id", brokerageId)
      .in("id", Array.from(buyers).slice(0, 500))
    if (seedError) console.warn("[lookalike-audience] research seed read refused:", seedError.message)
    else research = researchLookalikeDenominators(((seedRows ?? []) as Array<Record<string, unknown>>))
  }

  const weekStamp = now.toISOString().slice(0, 10)
  const campaignName = `${spec.name} — ${weekStamp}`
  const { data: existing } = await supabase.from("ad_campaigns").select("id")
    .eq("brokerage_id", brokerageId).eq("campaign_name", campaignName).limit(1).maybeSingle()
  if (existing) return { seedCount: buyers.size, staged: false, reason: "already staged this week" }

  const { error } = await supabase.from("ad_campaigns").insert({
    brokerage_id: brokerageId, campaign_name: campaignName, platform: "facebook",
    status: "draft", objective: "lead_generation", targeting_config: { ...spec.targeting, research },
  })
  return { seedCount: buyers.size, staged: !error, reason: error ? error.message : undefined }
}
