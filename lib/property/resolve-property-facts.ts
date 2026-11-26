/**
 * lib/property/resolve-property-facts.ts
 *
 * Wave 61 — the UNIFIED property-facts resolver. A property reference (e.g.
 * property_matches.property_id, a saved-property id, a showing target) can point at
 * EITHER our own brokerage `listings` row OR a cached external-MLS property in
 * `saved_properties` (source = rentcast | idx | mls | brokerage_listing | manual —
 * default RentCast, IDXBroker when the agent has it connected). Before this, each
 * consumer resolved properties differently (showing-brief, buyer-portal-matches, the
 * reel producer) → drift. This is the ONE place that resolves a property id (uuid) to
 * displayable facts from BOTH sources, so callers stop re-implementing the lookup.
 *
 * Batch-friendly: pass many ids, get a Map. Both id spaces are uuid and disjoint
 * (a listings.id never collides with a saved_properties.id), so the merge is safe.
 */
import { createServiceClient } from "@/lib/supabase/service"

export interface PropertyFacts {
  id:        string
  address:   string | null
  city:      string | null
  state:     string | null
  price:     number | null
  bedrooms:  number | null
  bathrooms: number | null
  photoUrl:  string | null
  /** Where the facts came from: our listing, or a cached external/MLS snapshot. */
  source:    "listing" | "saved" | string

  // ── BOTH IDS (m315) ────────────────────────────────────────────────────────
  // A property reaches this OS by one of two doors and a caller needs to know
  // which: an in-house listing we control, or an outside listing we only have a
  // snapshot of. `id` is just the row we matched on; these two say what it IS.
  /** OUR listings.id when this is an in-house listing — directly, or because a
   *  saved/external row links back to one via saved_properties.listing_id. */
  listingId: string | null
  /** The OUTSIDE identifier for a third-party listing: the MLS number when we
   *  have one, else the vendor's own property id. NULL for our own listings. */
  propertyId: string | null
  /** The MLS number specifically, when known — the id an agent recognises. */
  mlsNumber: string | null
  /** Where a human can go look at the outside listing. */
  listingUrl: string | null

  /**
   * Is this home still on the market?
   *
   * NULL means UNKNOWN — not "available". A buyer shown a home that sold last
   * week is the most damaging kind of wrong this product can be, so an unknown
   * is never quietly treated as for-sale.
   */
  status:    string | null
  /**
   * WHERE the status came from, declared rather than assumed.
   *
   * "listing"        our own listings row — authoritative and free.
   * "linked_listing" an external snapshot that points back at one of our
   *                  listings (saved_properties.listing_id) — same authority,
   *                  still free, and the reason most "external" matches are in
   *                  fact checkable.
   * "rentcast"       looked up live against the vendor (tenant key, else the
   *                  platform key).
   * "unknown"        no lane could answer. Only here is availability unknowable.
   */
  statusSource: "listing" | "linked_listing" | "rentcast" | "unknown"
}

/** Listing statuses that mean a buyer can still pursue the home. */
export const AVAILABLE_STATUSES = ["active", "coming_soon"] as const

/**
 * True when a status means the home is OFF the market.
 *
 * Unknown (null) is deliberately NOT unavailable — we do not know, and inventing
 * bad news about a third-party listing is its own failure.
 */
export function isUnavailableStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return !(AVAILABLE_STATUSES as readonly string[]).includes(status)
}

/**
 * Resolve property ids (uuid) to facts, checking our listings AND the saved/external
 * cache. Brokerage-scoped. Returns a Map keyed by id (missing ids simply absent).
 */
export async function resolvePropertyFacts(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  ids: string[],
): Promise<Map<string, PropertyFacts>> {
  const out = new Map<string, PropertyFacts>()
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (!brokerageId || unique.length === 0) return out

  // (1) Our brokerage listings.
  try {
    const { data } = await supabase.from("listings")
      .select("id, address, city, state, list_price, bedrooms, bathrooms, status")
      .eq("brokerage_id", brokerageId).in("id", unique)
    for (const l of (data ?? []) as any[]) {
      out.set(l.id, {
        id: l.id, address: l.address ?? null, city: l.city ?? null, state: l.state ?? null,
        price: l.list_price ?? null, bedrooms: l.bedrooms ?? null, bathrooms: l.bathrooms ?? null,
        photoUrl: null, source: "listing",
        listingId: l.id, propertyId: null, mlsNumber: null, listingUrl: null,
        status: l.status ?? null, statusSource: "listing",
      })
    }
  } catch { /* best-effort */ }

  // (2) Cached external / MLS snapshots (RentCast / IDX / MLS) — carries the photo.
  const remaining = unique.filter((id) => !out.has(id))
  if (remaining.length > 0) {
    try {
      const { data } = await supabase.from("saved_properties")
        .select("id, property_address, city, state, list_price, bedrooms, bathrooms, primary_photo_url, source, listing_id, mls_number, external_property_id, listing_url")
        .eq("brokerage_id", brokerageId).in("id", remaining)
      const savedRows = (data ?? []) as any[]

      // A saved row that LINKS BACK to one of our listings is not really an
      // outside property — we own the truth about it. Resolve those statuses in
      // one extra query rather than sending them to a paid vendor lookup.
      const linkedIds = Array.from(new Set(
        savedRows.map((r) => r.listing_id).filter(Boolean) as string[]))
      const linkedStatus = new Map<string, string | null>()
      if (linkedIds.length > 0) {
        try {
          const { data: linked } = await supabase.from("listings")
            .select("id, status").eq("brokerage_id", brokerageId).in("id", linkedIds)
          for (const l of (linked ?? []) as any[]) linkedStatus.set(l.id, l.status ?? null)
        } catch { /* fall through to unknown */ }
      }

      for (const s of savedRows) {
        const linked = s.listing_id ? linkedStatus.get(s.listing_id) : undefined
        out.set(s.id, {
          id: s.id, address: s.property_address ?? null, city: s.city ?? null, state: s.state ?? null,
          price: s.list_price ?? null, bedrooms: s.bedrooms ?? null, bathrooms: s.bathrooms ?? null,
          photoUrl: s.primary_photo_url ?? null, source: s.source ?? "saved",
          listingId: s.listing_id ?? null,
          // The outside identifier an agent would recognise first.
          propertyId: s.mls_number ?? s.external_property_id ?? null,
          mlsNumber: s.mls_number ?? null,
          listingUrl: s.listing_url ?? null,
          status: linked ?? null,
          statusSource: linked !== undefined ? "linked_listing" : "unknown",
        })
      }
    } catch { /* best-effort */ }
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFYING AN OUTSIDE LISTING (m315)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill in availability for properties we could not answer from our own data.
 *
 * OPT-IN, and separate from resolvePropertyFacts on purpose. The resolver runs
 * on render-time paths where a per-property network call would be slow and
 * metered; this runs on the living-video sweep, where the whole job is telling
 * the truth about what a client was shown. Callers ask for it explicitly.
 *
 * Only rows still at statusSource "unknown" are looked up — an in-house listing
 * and a saved row that links back to one are already authoritative and free.
 *
 * RentCast resolves through the tenant's own key when they have one and the
 * PLATFORM key otherwise, so an agent with no vendor account of their own is
 * still covered by the platform's. A lookup that fails leaves the row unknown
 * rather than guessing — mutating this into "available" would be inventing the
 * exact reassurance a buyer must not be given.
 */
export async function verifyExternalAvailability(
  brokerageId: string,
  facts: PropertyFacts[],
): Promise<PropertyFacts[]> {
  const needsCheck = facts.filter((f) => f.statusSource === "unknown" && f.propertyId)
  if (needsCheck.length === 0) return facts

  try {
    const { getRentcastListingStatus } = await import("./rentcast")
    const resolved = new Map<string, string | null>()
    for (const f of needsCheck) {
      const status = await getRentcastListingStatus({ brokerageId, externalId: f.propertyId! })
      if (status) resolved.set(f.id, status)
    }
    if (resolved.size === 0) return facts
    return facts.map((f) => {
      const s = resolved.get(f.id)
      return s ? { ...f, status: s, statusSource: "rentcast" as const } : f
    })
  } catch {
    // The vendor is down or unconfigured. Unknown stays unknown.
    return facts
  }
}

/**
 * Normalize a vendor status onto our listing vocabulary.
 *
 * RentCast says "Active" / "Inactive"; our listings CHECK speaks
 * active/pending/sold/withdrawn/... Anything we do not recognise maps to
 * "off_market" rather than to active, because the safe direction for a buyer is
 * to stop advertising a home we are unsure about.
 */
export function normalizeVendorStatus(vendorStatus: string | null | undefined): string | null {
  if (!vendorStatus) return null
  const v = vendorStatus.trim().toLowerCase()
  if (v === "active" || v === "for sale" || v === "forsale") return "active"
  if (v === "coming soon" || v === "comingsoon") return "coming_soon"
  if (v === "pending" || v === "under contract" || v === "contingent") return "pending"
  if (v === "sold" || v === "closed") return "sold"
  if (v === "withdrawn" || v === "cancelled" || v === "canceled") return "withdrawn"
  if (v === "expired") return "expired"
  return "off_market"
}
