/**
 * lib/property/address-lookup.ts
 *
 * OSINT-first property enrichment from a street address.
 * Tier 1 (free): Perplexity Sonar — searches public county records,
 *   Zillow public pages, county assessor data, and real estate sites
 *   without API key costs. Returns beds/baths/sqft/year_built etc.
 * Fallback: returns null fields (no crash — callers degrade gracefully).
 *
 * Usage: agent types an address in listing wizard → auto-fill fires.
 * No MLS data stored — public record data only.
 */

import { generateTextRouted } from "@/lib/ai/models"

export interface AddressLookupResult {
  beds: number | null
  baths: number | null
  sqft: number | null
  yearBuilt: number | null
  lotSizeAcres: number | null
  propertyType: string | null       // 'single_family' | 'condo' | 'townhouse' | 'multi_family' | 'land'
  stories: number | null
  garageSpaces: number | null
  hasPool: boolean | null
  hasHoa: boolean | null
  taxAssessedValue: number | null
  lastSalePrice: number | null
  lastSaleDate: string | null       // ISO date
  neighborhoodSummary: string | null
  dataConfidence: 'high' | 'medium' | 'low'
  sources: string[]                 // e.g. ['county_assessor', 'zillow_public']
}

const EMPTY_RESULT: AddressLookupResult = {
  beds: null, baths: null, sqft: null, yearBuilt: null,
  lotSizeAcres: null, propertyType: null, stories: null,
  garageSpaces: null, hasPool: null, hasHoa: null,
  taxAssessedValue: null, lastSalePrice: null, lastSaleDate: null,
  neighborhoodSummary: null, dataConfidence: 'low', sources: [],
}

/**
 * Look up publicly available property details for a given address.
 * Uses Perplexity Sonar (live web search) to pull county assessor
 * data, public MLS history, and real estate portal data.
 *
 * Cost: ~$0.005–0.015 per call (Perplexity Sonar).
 * Fallback: returns EMPTY_RESULT on any failure.
 */
export async function lookupPropertyByAddress(params: {
  address: string
  city: string
  state: string
  zip?: string
}): Promise<AddressLookupResult> {
  const { address, city, state, zip } = params
  const fullAddress = [address, city, state, zip].filter(Boolean).join(", ")

  const prompt = `
Look up publicly available property details for: ${fullAddress}

Search county assessor records, Zillow public pages, Redfin public pages,
and public real estate databases. Return ONLY a JSON object with these fields
(use null for any field you cannot find with confidence):

{
  "beds": <integer or null>,
  "baths": <number or null, e.g. 2.5>,
  "sqft": <integer or null>,
  "yearBuilt": <integer or null>,
  "lotSizeAcres": <number or null>,
  "propertyType": <"single_family"|"condo"|"townhouse"|"multi_family"|"land"|null>,
  "stories": <integer or null>,
  "garageSpaces": <integer or null>,
  "hasPool": <true|false|null>,
  "hasHoa": <true|false|null>,
  "taxAssessedValue": <integer in dollars or null>,
  "lastSalePrice": <integer in dollars or null>,
  "lastSaleDate": <"YYYY-MM-DD" or null>,
  "neighborhoodSummary": <1–2 sentence factual summary of the neighborhood or null>,
  "dataConfidence": <"high"|"medium"|"low">,
  "sources": [<list of data sources found>]
}

Respond with ONLY the JSON object. No explanation, no markdown.
`.trim()

  try {
    const { text } = await generateTextRouted({
      feature: "home_value_estimate",
      prompt,
      maxTokens: 512,
      temperature: 0,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return EMPTY_RESULT

    const parsed = JSON.parse(jsonMatch[0])

    return {
      beds: parsed.beds ?? null,
      baths: parsed.baths ?? null,
      sqft: parsed.sqft ?? null,
      yearBuilt: parsed.yearBuilt ?? null,
      lotSizeAcres: parsed.lotSizeAcres ?? null,
      propertyType: parsed.propertyType ?? null,
      stories: parsed.stories ?? null,
      garageSpaces: parsed.garageSpaces ?? null,
      hasPool: parsed.hasPool ?? null,
      hasHoa: parsed.hasHoa ?? null,
      taxAssessedValue: parsed.taxAssessedValue ?? null,
      lastSalePrice: parsed.lastSalePrice ?? null,
      lastSaleDate: parsed.lastSaleDate ?? null,
      neighborhoodSummary: parsed.neighborhoodSummary ?? null,
      dataConfidence: parsed.dataConfidence ?? 'low',
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    }
  } catch {
    return EMPTY_RESULT
  }
}
