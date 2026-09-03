"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
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
  //
  // ── THIS ONE IS GENUINELY PORTAL-FACING (wave 26, lane SEC3) ────────────────
  //
  // Its only caller is app/portal/[contactId]/properties/page.tsx:222, and the
  // person it is for is the BUYER reading their own match list. So the fix here
  // is not "staff only" — it is the shared portal gate, which answers BOTH
  // halves of the real question: is this the contact themselves, or is it staff
  // in the contact's tenant?
  //
  // What was wrong: the gate resolved the caller's `users.brokerage_id`, resolved
  // the contact's, and admitted on EQUALITY ALONE. There was no role test, and
  // `users.user_type` can hold `contact`, `vendor` and `lender` on rows that
  // carry a brokerage_id — so a vendor or lender seat, or ANY other buyer in the
  // brokerage, could read a stranger's saved matches. §5: those seats see only
  // their own. `requireContactAccess` refuses them and admits the buyer whose
  // record it is.
  //
  // It also FIXES A NARROWING nobody meant: requiring the CALLER's own
  // users.brokerage_id refused any buyer whose row has none, even on their own
  // portal page — a gate narrower than the surface that already admits them
  // (app/portal/[contactId]/layout.tsx). `isContactSelf` recognises them by the
  // same three facts the layout does.
  //
  // Not a financial payload, so `isContactSelf` is allowed here: these are the
  // buyer's own cached property matches plus PUBLIC listing facts (address,
  // list price, beds/baths). No commission, no credit, no transaction money.
  //
  // Tenant now comes from the CONTACT ROW via the gate, not from the caller —
  // the mechanical form of "can only get their contacts".
  const gate = await requireContactAccess(contactId)
  if (!gate.ok) {
    // The gate keeps "Access check failed" (a refused READ — an outage) apart
    // from "Forbidden" (a DECISION). Passing its sentence through unflattened
    // is the difference between telling a buyer to fix an account that was
    // never wrong and telling them the system could not answer (§4).
    return { success: false, matches: [], error: gate.error }
  }
  const brokerageId = gate.brokerageId

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

  // Resolve via the UNIFIED resolver so the portal shows matches from BOTH our listings
  // AND external MLS (RentCast/IDX) references — the old listings-only join silently
  // dropped every external match. sqft + go-live (DOM) are enriched from listings when ours.
  const { resolvePropertyFacts } = await import("@/lib/property/resolve-property-facts")
  const factsMap = await resolvePropertyFacts(supabase, brokerageId, propertyIds)
  const { data: listings } = await supabase
    .from("listings")
    .select("id, sqft, status, go_live_date")
    .eq("brokerage_id", brokerageId)
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
