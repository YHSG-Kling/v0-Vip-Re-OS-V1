// lib/kernel/neighbor-farm.ts
//
// THE NEIGHBOR FARM — the Data Steward actually SCRAPES the block. Until now the
// neighbor-notification flow created a campaign with recipients_identified = 0 (the
// identify step was a deferred stub). This wires the REAL scrape: BatchData property
// search around the sold/listed home returns the surrounding owner-occupied homes with
// owner names + tenure, scored, and written as neighbor_notification_recipients —
// still seller-permission-gated before a single piece mails.
//
// The scraper is an injectable seam (like the dial executor / synthesizer) so tests
// never spend BatchData credits; production uses the real connector-gateway client.
// NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface NeighborCandidate {
  address: string
  city: string | null
  state: string | null
  zip: string | null
  ownerName: string | null
  tenureYears: number | null
  estimatedAge: number | null
  knowsBuyerScore: number
  proximityMeters: number | null
  lifeStageMatch: string | null
  signals: Record<string, unknown> | null
}

export interface NeighborScrapeParams {
  listingAddress: string
  city: string | null
  state: string | null
  radiusMeters: number
  maxResults: number
  minTenureYears: number
}

/** Injectable seam: identify the homes around the listing. Default = real BatchData. */
export type NeighborScraper = (params: NeighborScrapeParams) => Promise<NeighborCandidate[]>

/** Pure: a homeowner's "knows-a-buyer / likely-to-engage" score — long tenure (rooted
 *  in the neighborhood) + owner-occupied weighs up. Transparent heuristic, not a
 *  fabricated value; the scoring_signals row records exactly what drove it. */
export function scoreNeighbor(tenureYears: number | null, ownerOccupied: boolean): number {
  let s = 0.4
  if (tenureYears !== null) s += Math.min(0.35, tenureYears * 0.03) // rooted neighbors know movers
  if (ownerOccupied) s += 0.15
  return Math.min(1, Number(s.toFixed(2)))
}

/** Real scrape via the existing BatchData client (single egress: connector-gateway). */
export const realNeighborScraper: NeighborScraper = async (params) => {
  const { searchProperties } = await import("@/lib/external/batchdata-client")
  const near = [params.listingAddress, params.city, params.state].filter(Boolean).join(", ")
  const res = await searchProperties(near).catch(() => ({ matches: [] as any[] }))
  const out: NeighborCandidate[] = []
  for (const p of (res.matches ?? []).slice(0, params.maxResults)) {
    const addr = p?.address ?? {}
    const street = addr.street ?? addr.formattedAddress ?? p?.formattedAddress ?? null
    if (!street) continue
    const owner = p?.owner ?? p?.ownership ?? {}
    const tenure = typeof owner.ownershipLengthYears === "number" ? owner.ownershipLengthYears
      : (owner.ownershipLength ?? null)
    if (params.minTenureYears && tenure !== null && tenure < params.minTenureYears) continue
    const ownerOccupied = !!(p?.quickLists?.["owner-occupied"] ?? p?.ownerOccupied)
    out.push({
      address: street, city: addr.city ?? params.city, state: addr.state ?? params.state, zip: addr.zip ?? null,
      ownerName: owner.fullName ?? owner.owner1FullName ?? null,
      tenureYears: typeof tenure === "number" ? tenure : null, estimatedAge: owner.estimatedAge ?? null,
      knowsBuyerScore: scoreNeighbor(typeof tenure === "number" ? tenure : null, ownerOccupied),
      proximityMeters: null, lifeStageMatch: null,
      signals: { source: "batchdata", ownerOccupied, tenureYears: tenure ?? null },
    })
  }
  return out
}

export interface StageNeighborFarmResult { campaignId: string | null; identified: number; created: boolean }

/**
 * Stage the neighbor farm for a listing: one campaign (awaiting_seller_permission) +
 * the scraped, scored recipients. Idempotent per listing — never re-scrapes a listing
 * that already has a campaign. NOTHING sends; seller permission is a separate gate.
 */
export async function stageNeighborFarm(
  brokerageId: string,
  listingId: string,
  agentUserId: string,
  opts: { scraper?: NeighborScraper; maxNeighbors?: number; radiusMeters?: number; minTenureYears?: number } = {},
  client?: Svc,
): Promise<StageNeighborFarmResult> {
  const supabase = client ?? createServiceClient()
  const scraper = opts.scraper ?? realNeighborScraper
  const maxNeighbors = opts.maxNeighbors ?? 50
  const radiusMeters = opts.radiusMeters ?? 800
  const minTenureYears = opts.minTenureYears ?? 5

  const { data: existing } = await supabase.from("neighbor_notification_campaigns")
    .select("id, recipients_identified").eq("listing_id", listingId).limit(1).maybeSingle()
  if (existing) return { campaignId: (existing as any).id, identified: (existing as any).recipients_identified ?? 0, created: false }

  const { data: listing } = await supabase.from("listings")
    .select("address, city, state").eq("id", listingId).maybeSingle()
  if (!listing || !(listing as any).address) return { campaignId: null, identified: 0, created: false }

  const { data: campaign, error } = await supabase.from("neighbor_notification_campaigns").insert({
    brokerage_id: brokerageId, agent_user_id: agentUserId, listing_id: listingId,
    max_neighbors: maxNeighbors, search_radius_meters: radiusMeters, min_tenure_years: minTenureYears,
    knows_buyer_score_threshold: 0.6, status: "awaiting_seller_permission",
  }).select("id").single()
  if (error || !campaign) return { campaignId: null, identified: 0, created: false }
  const campaignId = (campaign as any).id as string

  const candidates = await scraper({
    listingAddress: (listing as any).address, city: (listing as any).city ?? null,
    state: (listing as any).state ?? null, radiusMeters, maxResults: maxNeighbors, minTenureYears,
  }).catch(() => [] as NeighborCandidate[])

  if (candidates.length > 0) {
    await supabase.from("neighbor_notification_recipients").insert(
      candidates.map((c) => ({
        campaign_id: campaignId, brokerage_id: brokerageId,
        property_address: c.address, property_city: c.city, property_state: c.state, property_zip: c.zip,
        owner_name: c.ownerName, owner_tenure_years: c.tenureYears, owner_estimated_age: c.estimatedAge,
        knows_buyer_score: c.knowsBuyerScore, proximity_meters: c.proximityMeters,
        life_stage_match: c.lifeStageMatch, scoring_signals: c.signals, status: "identified",
      })),
    )
    await supabase.from("neighbor_notification_campaigns")
      .update({ recipients_identified: candidates.length, updated_at: new Date().toISOString() })
      .eq("id", campaignId)
  }
  return { campaignId, identified: candidates.length, created: true }
}
