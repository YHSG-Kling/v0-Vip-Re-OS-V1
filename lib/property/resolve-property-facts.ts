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
      .select("id, address, city, state, list_price, bedrooms, bathrooms")
      .eq("brokerage_id", brokerageId).in("id", unique)
    for (const l of (data ?? []) as any[]) {
      out.set(l.id, {
        id: l.id, address: l.address ?? null, city: l.city ?? null, state: l.state ?? null,
        price: l.list_price ?? null, bedrooms: l.bedrooms ?? null, bathrooms: l.bathrooms ?? null,
        photoUrl: null, source: "listing",
      })
    }
  } catch { /* best-effort */ }

  // (2) Cached external / MLS snapshots (RentCast / IDX / MLS) — carries the photo.
  const remaining = unique.filter((id) => !out.has(id))
  if (remaining.length > 0) {
    try {
      const { data } = await supabase.from("saved_properties")
        .select("id, property_address, city, state, list_price, bedrooms, bathrooms, primary_photo_url, source")
        .eq("brokerage_id", brokerageId).in("id", remaining)
      for (const s of (data ?? []) as any[]) {
        out.set(s.id, {
          id: s.id, address: s.property_address ?? null, city: s.city ?? null, state: s.state ?? null,
          price: s.list_price ?? null, bedrooms: s.bedrooms ?? null, bathrooms: s.bathrooms ?? null,
          photoUrl: s.primary_photo_url ?? null, source: s.source ?? "saved",
        })
      }
    } catch { /* best-effort */ }
  }

  return out
}
