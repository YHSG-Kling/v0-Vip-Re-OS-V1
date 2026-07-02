// lib/data-steward/property-spec-extractor.ts
//
// LOSSLESS PROPERTY SPECS (Data Steward) — the pure extractor that pulls property facts (beds / baths /
// sqft / property type / estimated value) out of a scraped raw record's jsonb so they can be promoted to
// first-class columns on leads + contacts. The scrapers already capture these (BatchData:
// building.bedroomCount / bathroomCount / livingAreaSquareFeet + valuation.estimatedValue, or the
// top-level beds/baths/sqft/estimatedValue the client normalizes; portal FSBO parsers: rawPayload.price),
// but they were being DROPPED at promotion. This reads them defensively across the many shapes the
// sources use, so a spec is captured wherever it lives — and HONESTLY returns null when it isn't there
// (never fabricated). Pure; unit-tested.

export interface PropertySpecs {
  beds: number | null
  baths: number | null
  sqft: number | null
  propertyType: string | null
  estimatedValue: number | null
}

type Obj = Record<string, any>

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(String(v).replace(/[^0-9.]/g, "")) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}
function toStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** Look up the first present value for any of `keys`, across the candidate object + its nested
 *  building/valuation/property/rawPayload sub-objects (the shapes BatchData + the parsers produce). */
function pick(candidates: Obj[], keys: string[], coerce: (v: unknown) => any): any {
  const nests = ["building", "valuation", "property", "rawPayload", "attributes", "features"]
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue
    const scopes: Obj[] = [c, ...nests.map((n) => c[n]).filter((x) => x && typeof x === "object")]
    for (const scope of scopes) {
      for (const k of keys) {
        const v = coerce(scope[k])
        if (v !== null && v !== undefined) return v
      }
    }
  }
  return null
}

/**
 * PURE: extract property specs from the raw record's jsonb sources (raw_data + normalized_preview and
 * any first-class raw columns), reading each field across the vendor/parser spellings. Missing → null.
 */
export function extractPropertySpecs(sources: Array<Obj | null | undefined>): PropertySpecs {
  const c = sources.filter((s): s is Obj => !!s && typeof s === "object")
  return {
    beds: pick(c, ["beds", "bedrooms", "bedroomCount", "bed", "numberOfBedrooms"], toNum),
    baths: pick(c, ["baths", "bathrooms", "bathroomCount", "bath", "numberOfBathrooms"], toNum),
    sqft: pick(c, ["sqft", "squareFeet", "livingAreaSquareFeet", "livingArea", "buildingAreaSqft", "square_feet"], toNum),
    propertyType: pick(c, ["propertyType", "property_type", "propertyTypeDetail", "propertyUseType", "useType", "type"], toStr),
    estimatedValue: pick(c, ["estimatedValue", "estimated_value", "avm", "avmValue", "marketValue", "price", "listPrice", "list_price"], toNum),
  }
}

/** Column patch for a LEADS insert/update (leads has estimated_value first-class). Only sets fields we
 *  actually found (leaves the rest untouched — additive, never nulls out an existing value). */
export function leadSpecPatch(specs: PropertySpecs): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (specs.beds != null) p.beds = Math.round(specs.beds)
  if (specs.baths != null) p.baths = specs.baths
  if (specs.sqft != null) p.sqft = Math.round(specs.sqft)
  if (specs.propertyType != null) p.property_type = specs.propertyType
  if (specs.estimatedValue != null) p.estimated_value = specs.estimatedValue
  return p
}

/** Column patch for a CONTACTS insert/update. Contacts store value in home_value_estimate (not
 *  estimated_value), so the property value lands there when present. */
export function contactSpecPatch(specs: PropertySpecs): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (specs.beds != null) p.beds = Math.round(specs.beds)
  if (specs.baths != null) p.baths = specs.baths
  if (specs.sqft != null) p.sqft = Math.round(specs.sqft)
  if (specs.propertyType != null) p.property_type = specs.propertyType
  if (specs.estimatedValue != null) p.home_value_estimate = specs.estimatedValue
  return p
}
