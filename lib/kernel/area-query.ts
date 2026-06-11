// lib/kernel/area-query.ts
//
// "HEY TEAM, ANYTHING HAPPENING NEAR 44 BIRCH?" — the bullpen, but for a PLACE instead
// of a person. The marketing-side managers report what they're doing in an area so the
// agent can answer a seller's "what are you doing to sell homes around here?" on the spot:
//
//   · Listing Concierge — our active listings in that area (the inventory we're working)
//   · Asset Manager     — promo reels for those listings (rendered + in the pipeline):
//                         reusable media the agent can share or repurpose right now
//   · Ads Manager       — live paid campaigns whose targeting includes the area
//
// The area resolves from a spoken address (match a listing → use its city) or a bare
// place name. One spoken, manager-attributed answer; honest when nothing's running.
// READ-ONLY — reporting, never acting. NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export interface AreaContribution { manager: ManagerKey; line: string }

/** Pure: resolve the area name. If the query matches a listing's address, use that
 *  listing's city; otherwise treat the query itself as the place. */
export function resolveAreaName(
  listings: Array<{ address: string | null; city: string | null }>, query: string,
): string {
  const tokens = query.toLowerCase().split(/[\s,]+/).filter(Boolean)
  const hit = listings.find((l) => {
    const addr = (l.address ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean)
    return tokens.length > 0 && tokens.every((t) =>
      /^\d+$/.test(t) ? addr.includes(t) : addr.some((a) => a.startsWith(t)))
  })
  return (hit?.city ?? query).trim()
}

/** Pure: compose the spoken area answer — manager-attributed, honest when empty. */
export function composeAreaAnswer(area: string, contributions: AreaContribution[]): string {
  if (contributions.length === 0) {
    return `Nothing's running in ${area} right now — no active listings, no reels, no live ads. Want me to start a campaign there?`
  }
  const lines = contributions.map((c) => `${MANAGERS[c.manager].label}: ${c.line}`)
  return `Here's what the team has going in ${area}. ${lines.join(" ")}`
}

export interface AreaQueryResult {
  area: string
  spoken: string
  contributions: AreaContribution[]
}

/**
 * Ask the marketing bench what's happening in an area. Every fact from a real table;
 * managers with nothing to report stay silent. Read-only.
 */
export async function runAreaQuery(
  brokerageId: string, areaQuery: string, client?: Svc,
): Promise<AreaQueryResult> {
  const supabase = client ?? createServiceClient()
  const cleaned = areaQuery.replace(/[%,()]/g, "").trim()

  // Resolve the area: match a listing address → its city, else the bare query.
  const { data: addrMatches } = await supabase.from("listings")
    .select("address, city").eq("brokerage_id", brokerageId)
    .or(`address.ilike.%${cleaned}%,city.ilike.%${cleaned}%`).limit(25)
  const area = resolveAreaName(((addrMatches ?? []) as any[]), cleaned)

  // Listing Concierge — our active listings in that city.
  const { data: listings } = await supabase.from("listings")
    .select("id, status").eq("brokerage_id", brokerageId).ilike("city", area)
    .in("status", ["active", "coming_soon", "pending"]).limit(200)
  const listingRows = (listings ?? []) as Array<{ id: string; status: string | null }>
  const c: AreaContribution[] = []
  if (listingRows.length > 0) {
    c.push({ manager: "listing_concierge", line: `we have ${listingRows.length} active listing${listingRows.length === 1 ? "" : "s"} in ${area} on the board.` })

    // Asset Manager — reusable promo media for those listings.
    const ids = listingRows.map((l) => l.id)
    const { data: promos } = await supabase.from("listing_promo_videos")
      .select("status").in("listing_id", ids).limit(200)
    const promoRows = (promos ?? []) as Array<{ status: string | null }>
    // listing_promo_videos.status CHECK: queued|remotion_pending|rendering|
    // social_drafted|failed|suppressed. "Ready to share" is the terminal success
    // state social_drafted; the in-flight states are queued/remotion_pending/rendering.
    const ready = promoRows.filter((p) => p.status === "social_drafted").length
    const pipeline = promoRows.filter((p) => ["queued", "remotion_pending", "rendering"].includes(p.status ?? "")).length
    if (ready + pipeline > 0) {
      c.push({ manager: "asset_manager", line: `${ready} reel${ready === 1 ? "" : "s"} ready to share${pipeline > 0 ? ` and ${pipeline} more rendering` : ""} for those homes.` })
    }
  }

  // Ads Manager — live/launching campaigns whose targeting includes the area.
  const { data: ads } = await supabase.from("ad_campaigns")
    .select("campaign_name, targeting_config, status").eq("brokerage_id", brokerageId)
    .in("status", ["live", "launching"]).limit(200)
  const areaLc = area.toLowerCase()
  const matchingAds = ((ads ?? []) as any[]).filter((a) => {
    const locs = (a.targeting_config?.locations ?? []) as unknown[]
    return Array.isArray(locs) && locs.some((loc) => String(loc).toLowerCase().includes(areaLc))
  })
  if (matchingAds.length > 0) {
    c.push({ manager: "ads_manager", line: `${matchingAds.length} paid campaign${matchingAds.length === 1 ? " is" : "s are"} live targeting ${area} right now.` })
  }

  return { area, spoken: composeAreaAnswer(area, c), contributions: c }
}
