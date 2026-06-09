"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

export interface BuyerPortalMatch {
  id: string
  property_id: string
  match_score: number
  match_reasons: string[]
  potential_concerns: string[]
  // Listing fields (joined)
  address: string | null
  city: string | null
  state: string | null
  list_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  status: string | null
  days_on_market: number | null
  primary_photo_url: string | null
}

/**
 * Returns cached property matches for a buyer, joined with listing details.
 * Backed by the property_matches upserts written by generatePropertyMatches().
 */
export async function getBuyerPortalMatches(contactId: string, limit = 12): Promise<{
  success: boolean
  matches: BuyerPortalMatch[]
  error?: string
}> {
  // Auth gate — was previously unauthenticated, leaking any buyer's saved
  // match list to anyone who could enumerate contact UUIDs.
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, matches: [], error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, matches: [], error: "Unauthorized" }

  const supabase = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || contact.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, matches: [], error: "Forbidden" }
  }

  const { data: matchRows, error } = await supabase
    .from("property_matches")
    .select("id, property_id, match_score, match_reasons, potential_concerns, generated_at")
    .eq("contact_id", contactId)
    .order("match_score", { ascending: false })
    .limit(limit)

  if (error) {
    return { success: false, matches: [], error: error.message }
  }
  if (!matchRows || matchRows.length === 0) {
    return { success: true, matches: [] }
  }

  const propertyIds = matchRows.map((m: any) => m.property_id).filter(Boolean)
  if (propertyIds.length === 0) {
    return { success: true, matches: [] }
  }

  // Resolve via the UNIFIED resolver so the portal shows matches from BOTH our listings
  // AND external MLS (RentCast/IDX) references — the old listings-only join silently
  // dropped every external match. sqft + go-live (DOM) are enriched from listings when ours.
  const { resolvePropertyFacts } = await import("@/lib/property/resolve-property-facts")
  const factsMap = await resolvePropertyFacts(supabase, callerRow.brokerage_id, propertyIds)
  const { data: listings } = await supabase
    .from("listings")
    .select("id, sqft, status, go_live_date")
    .eq("brokerage_id", callerRow.brokerage_id)
    .in("id", propertyIds)
  const ours = new Map<string, any>()
  for (const l of listings ?? []) ours.set(l.id, l)

  const matches: BuyerPortalMatch[] = matchRows
    .map((m: any) => {
      const f = factsMap.get(m.property_id)
      if (!f) return null
      const l = ours.get(m.property_id)
      return {
        id: m.id as string,
        property_id: m.property_id as string,
        match_score: m.match_score as number,
        match_reasons: (m.match_reasons ?? []) as string[],
        potential_concerns: (m.potential_concerns ?? []) as string[],
        address: f.address,
        city: f.city,
        state: f.state,
        list_price: f.price,
        bedrooms: f.bedrooms,
        bathrooms: f.bathrooms,
        sqft: l?.sqft ?? null,
        status: l?.status ?? (f.source === "listing" ? null : "external"),
        // DOM from go_live_date (our listings only — external has none).
        days_on_market: l ? computeDaysOnMarket(l.go_live_date) : null,
        // Compliant: external (market_watch) references store NO photo (re-fetched elsewhere).
        primary_photo_url: f.photoUrl,
      } as BuyerPortalMatch
    })
    .filter((x): x is BuyerPortalMatch => x !== null)

  return { success: true, matches }
}
