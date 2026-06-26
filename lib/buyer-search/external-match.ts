/**
 * lib/buyer-search/external-match.ts
 *
 * Wave 63 — COMPLIANT external (RentCast/IDX) market matching. Extends the market watch
 * beyond our own inventory to the whole market, WITHOUT violating RentCast ToS / MLS IDX
 * display rules. Compliance invariants (enforced here, not by convention):
 *   • photos are NEVER stored (primary_photo_url = NULL) — re-fetched at display time,
 *   • only a factual snapshot (address/price/beds/baths) is cached, short-lived,
 *   • source attribution ('rentcast'|'idx') + listing_url are kept,
 *   • every system reference is marked notes='market_watch_ref' and TTL-purged.
 * User-saved favorites (notes != marker) are never touched by the purge.
 *
 * The external SEARCH (RentCast/IDX HTTP) runs only when a connector is configured — it
 * gracefully no-ops (source 'none') otherwise. The persistence + matching + purge logic
 * is what we own and test.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { loadBuyerCriteria, scoreCriteriaFit, MATCH_FIT_THRESHOLD, type BuyerCriteria } from "./market-watch"
import type { ExternalListing } from "@/lib/property/external-listings-search"

type Svc = ReturnType<typeof createServiceClient>

export const MARKET_WATCH_REF_MARKER = "market_watch_ref"
export const EXTERNAL_REF_TTL_DAYS = 3   // short-lived per RentCast/MLS refresh rules
const MAX_EXTERNAL = 10

export interface ExternalMatchResult { external: number; source: string; reason?: string }

/**
 * PURE: the COMPLIANT saved_properties reference row for an external listing. Asserts the
 * compliance shape — NO photo stored, factual snapshot only, source attribution, TTL marker.
 */
export function buildExternalReferenceRow(
  ext: Pick<ExternalListing, "externalId" | "source" | "address" | "city" | "state" | "price" | "bedrooms" | "bathrooms"> & { listingUrl?: string | null },
  ctx: { brokerageId: string; contactId: string; userId: string; fitScore: number },
): Record<string, unknown> {
  return {
    brokerage_id:        ctx.brokerageId,
    contact_id:          ctx.contactId,
    user_id:             ctx.userId,
    source:              ext.source,              // 'rentcast' | 'idx' — attribution
    external_property_id: ext.externalId,
    property_address:    ext.address ?? null,
    city:                ext.city ?? null,
    state:               ext.state ?? null,
    list_price:          ext.price ?? null,
    bedrooms:            ext.bedrooms ?? null,
    bathrooms:           ext.bathrooms ?? null,
    primary_photo_url:   null,                    // NEVER store external photos — re-fetch at display
    listing_url:         ext.listingUrl ?? null,
    ai_match_score:      ctx.fitScore,
    notes:               MARKET_WATCH_REF_MARKER, // system reference → TTL-purged
  }
}

/** Idempotently upsert the compliant reference, returning its saved_properties.id. */
async function writeExternalMatchReference(
  svc: Svc, row: Record<string, unknown>,
): Promise<string | null> {
  // Idempotent on (contact_id, source, external_property_id) — saved_properties has no unique
  // there, so check-then-insert; refresh the factual snapshot if it already exists.
  const { data: existing } = await svc.from("saved_properties")
    .select("id").eq("contact_id", row.contact_id as string)
    .eq("source", row.source as string).eq("external_property_id", row.external_property_id as string)
    .eq("notes", MARKET_WATCH_REF_MARKER).maybeSingle()
  if (existing) {
    const id = (existing as { id: string }).id
    await svc.from("saved_properties").update({
      property_address: row.property_address, list_price: row.list_price,
      bedrooms: row.bedrooms, bathrooms: row.bathrooms, ai_match_score: row.ai_match_score, saved_at: new Date().toISOString(),
    }).eq("id", id)
    return id
  }
  const { data, error } = await svc.from("saved_properties").insert({ ...row, saved_at: new Date().toISOString() }).select("id").maybeSingle()
  if (error || !data) return null
  return (data as { id: string }).id
}

/**
 * Run external (RentCast/IDX) matching for ONE buyer: search the market by criteria, write
 * COMPLIANT display-only references for qualifying results, and a property_matches row for
 * each (property_id = the reference's saved_properties.id). Connector-gated (no-op when no
 * external source). Idempotent.
 */
export async function runExternalMarketWatchForBuyer(
  svc: Svc, brokerageId: string, contactId: string,
): Promise<ExternalMatchResult> {
  if (!brokerageId || !contactId) return { external: 0, source: "none", reason: "missing ids" }
  const criteria = await loadBuyerCriteria(svc, contactId)
  if (!criteria) return { external: 0, source: "none", reason: "no criteria" }

  // saved_properties.user_id is NOT NULL — resolve the buyer's agent user.
  const { data: c } = await svc.from("contacts").select("agent_id").eq("id", contactId).maybeSingle()
  let userId: string | null = null
  const agentId = (c as { agent_id: string | null } | null)?.agent_id ?? null
  if (agentId) {
    const { data: a } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
    userId = (a as { user_id: string | null } | null)?.user_id ?? null
  }
  if (!userId) return { external: 0, source: "none", reason: "no agent user for reference ownership" }

  const { searchExternalListings } = await import("@/lib/property/external-listings-search")
  const result = await searchExternalListings({
    brokerageId, city: criteria.cities[0], bedroomsMin: criteria.minBeds ?? undefined,
    bathroomsMin: criteria.minBaths ?? undefined, priceMin: criteria.minPrice ?? undefined,
    priceMax: criteria.maxPrice ?? undefined, limit: MAX_EXTERNAL,
  })
  if (result.source === "none" || result.listings.length === 0) return { external: 0, source: result.source }

  let external = 0
  for (const ext of result.listings.slice(0, MAX_EXTERNAL)) {
    const score = scoreCriteriaFit(criteria, { list_price: ext.price, bedrooms: ext.bedrooms, bathrooms: ext.bathrooms, city: ext.city })
    if (score < MATCH_FIT_THRESHOLD) continue
    const row = buildExternalReferenceRow({ ...ext, listingUrl: null }, { brokerageId, contactId, userId, fitScore: score })
    const refId = await writeExternalMatchReference(svc, row)
    if (!refId) continue
    await svc.from("property_matches").upsert({
      brokerage_id: brokerageId, contact_id: contactId, property_id: refId,
      match_score: score, ai_generated: false,
      match_reasons: { source: "market_watch_external", external_source: ext.source, fit_score: score },
    }, { onConflict: "contact_id,property_id" })
    external++
  }
  return { external, source: result.source }
}

/** The interest levels that mean the BUYER explicitly engaged the property — a real save the
 *  compliance purge must NEVER delete (the TTL is for untouched system suggestions only). */
const DURABLE_INTEREST_LEVELS = new Set(["saved", "favorited", "tour_requested", "offer_requested"])

/**
 * isDurableBuyerInterest — PURE. True when the buyer has explicitly engaged this property (saved /
 * favorited / requested a tour or offer, or it's on their tour list). Defense in depth: even if a
 * save path failed to clear the market_watch_ref marker, an engaged property is never a "stale
 * system suggestion" and must survive the TTL purge. A dismissed/untouched ref is purgeable.
 */
export function isDurableBuyerInterest(interestLevel: string | null | undefined, addedToTour: boolean | null | undefined): boolean {
  if (addedToTour === true) return true
  return !!interestLevel && DURABLE_INTEREST_LEVELS.has(interestLevel)
}

/**
 * Purge stale system external references (compliance: external MLS data must be short-lived).
 * Deletes market_watch_ref saved_properties older than the TTL + their property_matches.
 * NEVER touches a property the buyer explicitly engaged — saves/favorites/tours/offers survive
 * regardless of the marker (defense in depth: the marker is mutable; buyer intent is the truth).
 */
export async function purgeStaleExternalReferences(svc: Svc, ttlDays = EXTERNAL_REF_TTL_DAYS): Promise<{ purged: number }> {
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
  const { data: stale } = await svc.from("saved_properties")
    .select("id, interest_level, added_to_tour").eq("notes", MARKET_WATCH_REF_MARKER).lt("saved_at", cutoff).limit(500)
  const rows = (stale ?? []) as Array<{ id: string; interest_level: string | null; added_to_tour: boolean | null }>
  // Skip any row the buyer engaged with — a saved/toured home is never a "stale suggestion".
  const ids = rows.filter((r) => !isDurableBuyerInterest(r.interest_level, r.added_to_tour)).map((r) => r.id)
  if (ids.length === 0) return { purged: 0 }
  try { await svc.from("property_matches").delete().in("property_id", ids) } catch {}
  await svc.from("saved_properties").delete().in("id", ids)
  return { purged: ids.length }
}
