/**
 * lib/buyer-search/buyer-criteria.ts
 *
 * Wave 65 — THE single normalized reader of a buyer's saved criteria. Before this, the
 * matcher, the market watch, and the showing brief each read property_preferences with
 * their OWN column lists (drift: each could miss/typo a column — the matcher already had
 * the `preferred_bedrooms`/`price` bug). This is the one place the criteria columns are
 * read + normalized (explicit `preferred_*` wins over AI `inferred_*`), so every consumer
 * agrees and a schema change is a one-line edit.
 */
import { createServiceClient } from "@/lib/supabase/service"

export interface BuyerCriteria {
  minPrice:        number | null
  maxPrice:        number | null
  minBeds:         number | null
  minBaths:        number | null
  cities:          string[]
  zipCodes:        string[]
  propertyTypes:   string[]
  mustHaveFeatures: string[]
  dealBreakers:    string[]
  confidenceScore: number | null
}

const num = (v: any): number | null => (typeof v === "number" && !Number.isNaN(v)) ? v : null
const arr = (v: any): string[] => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []

/**
 * The canonical property_preferences criteria column list — the ONE place it's defined.
 * Any consumer that reads buyer criteria selects via this (or calls loadBuyerCriteria) so a
 * column rename/typo can't silently diverge across the matcher / watch / brief / insights.
 */
export const BUYER_CRITERIA_SELECT =
  "preferred_price_min, preferred_price_max, inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, inferred_cities, inferred_zip_codes, inferred_property_types, inferred_must_have_features, inferred_deal_breakers, confidence_score"

/** Read + normalize one buyer's criteria from property_preferences (explicit > inferred). */
export async function loadBuyerCriteria(
  supabase: ReturnType<typeof createServiceClient>, contactId: string,
): Promise<BuyerCriteria | null> {
  const { data } = await supabase.from("property_preferences")
    .select(BUYER_CRITERIA_SELECT)
    .eq("contact_id", contactId).maybeSingle()
  if (!data) return null
  const p = data as Record<string, any>
  return {
    minPrice:         num(p.preferred_price_min) ?? num(p.inferred_min_price),
    maxPrice:         num(p.preferred_price_max) ?? num(p.inferred_max_price),
    minBeds:          num(p.inferred_beds_min),
    minBaths:         num(p.inferred_baths_min),
    cities:           arr(p.inferred_cities),
    zipCodes:         arr(p.inferred_zip_codes),
    propertyTypes:    arr(p.inferred_property_types),
    mustHaveFeatures: arr(p.inferred_must_have_features),
    dealBreakers:     arr(p.inferred_deal_breakers),
    confidenceScore:  num(p.confidence_score),
  }
}
