"use server"

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
  const supabase = createServiceClient()

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

  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, city, state, list_price, bedrooms, bathrooms, sqft, status, go_live_date")
    .in("id", propertyIds)

  const byId = new Map<string, any>()
  for (const l of listings ?? []) byId.set(l.id, l)

  const matches: BuyerPortalMatch[] = matchRows
    .map((m: any) => {
      const l = byId.get(m.property_id)
      if (!l) return null
      return {
        id: m.id as string,
        property_id: m.property_id as string,
        match_score: m.match_score as number,
        match_reasons: (m.match_reasons ?? []) as string[],
        potential_concerns: (m.potential_concerns ?? []) as string[],
        address: l.address ?? null,
        city: l.city ?? null,
        state: l.state ?? null,
        list_price: l.list_price ?? null,
        bedrooms: l.bedrooms ?? null,
        bathrooms: l.bathrooms ?? null,
        sqft: l.sqft ?? null,
        status: l.status ?? null,
        // DOM is computed from go_live_date — listings has no DOM column.
        days_on_market: computeDaysOnMarket(l.go_live_date),
        primary_photo_url: null,
      } as BuyerPortalMatch
    })
    .filter((x): x is BuyerPortalMatch => x !== null)

  return { success: true, matches }
}
