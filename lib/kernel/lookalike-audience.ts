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

export interface ClosingSeed { seedCount: number; cities: string[] }

/** Pure: the lookalike ad spec from the closing-table seed. Null when the seed is too
 *  thin (a 2-closing lookalike is noise, not signal). */
export function composeLookalike(seed: ClosingSeed): { name: string; targeting: Record<string, unknown> } | null {
  if (seed.seedCount < MIN_SEED) return null
  return {
    name: `Lookalike — ${seed.seedCount} past buyers`,
    targeting: {
      audience: "lookalike", seed_source: "closing_table", seed_count: seed.seedCount,
      locations: seed.cities.slice(0, 10),
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

  const weekStamp = now.toISOString().slice(0, 10)
  const campaignName = `${spec.name} — ${weekStamp}`
  const { data: existing } = await supabase.from("ad_campaigns").select("id")
    .eq("brokerage_id", brokerageId).eq("campaign_name", campaignName).limit(1).maybeSingle()
  if (existing) return { seedCount: buyers.size, staged: false, reason: "already staged this week" }

  const { error } = await supabase.from("ad_campaigns").insert({
    brokerage_id: brokerageId, campaign_name: campaignName, platform: "facebook",
    status: "draft", objective: "lead_generation", targeting_config: spec.targeting,
  })
  return { seedCount: buyers.size, staged: !error, reason: error ? error.message : undefined }
}
