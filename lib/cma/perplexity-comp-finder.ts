/**
 * PERPLEXITY COMP FINDER
 *
 * Tier-1 (free / cheap) comp source for the AI-CMA flow. Uses Perplexity
 * Sonar's web-search grounding to look up recent sales near the subject
 * property from public sources (Redfin, Zillow, Realtor.com, county records).
 *
 * Per the agent's CMA workflow:
 *   - 3 closest closed comps (sold within last 6 months, within 1 mile)
 *   - 1 pending comp
 *   - 1 active comp
 *
 * Returns structured comp data ready for adjustment computation. Citations
 * preserved for audit/disclaimer.
 *
 * Cost: ~$0.005-0.015 per CMA (Perplexity Sonar at $1/M input tokens, $1/M
 * output tokens, ~3-5k tokens per call). vs $0.30-1.00/CMA for paid AVM.
 *
 * Premium upgrade: agents click "Pull Premium CMA" before a listing
 * appointment to bypass this and use BatchData/HouseCanary directly. See
 * lib/cma/premium-comp-finder.ts (different path).
 */

import { generateTextRouted } from "@/lib/ai/models"
import type { CompFeatures } from "./state-adjustment-rates"

export interface PerplexityCompFinderInput {
  subjectAddress: string
  subjectCity?: string | null
  subjectState?: string | null
  subjectZip?: string | null
  subjectBeds?: number | null
  subjectBaths?: number | null
  subjectSqft?: number | null
  subjectYearBuilt?: number | null
  subjectPropertyType?: string | null  // 'single_family' | 'condo' | 'townhouse'
  searchRadiusMiles?: number           // default 1.0
  monthsBack?: number                  // default 6
  /**
   * For investor ARV mode — search for the BEST condition / recently
   * renovated comps to estimate the post-renovation value. Suppresses
   * condition-based downward adjustments.
   */
  arvMode?: boolean
}

export interface PerplexityCompFinderResult {
  closedComps: ScoredComp[]      // up to 3
  pendingComp: ScoredComp | null
  activeComp: ScoredComp | null
  citations: string[]
  searchQuery: string
  rawAnalysis: string
  arvMode: boolean
}

export interface ScoredComp extends CompFeatures {
  address: string
  status: "closed" | "pending" | "active"
  daysOnMarket?: number | null
  pricePerSqft?: number | null
  similarityScore: number  // 0..1 — Perplexity's similarity rating
  citation?: string | null  // source URL
}

/**
 * Search for comps via Perplexity Sonar with web grounding. Returns
 * structured JSON parsed from the model's response.
 */
export async function findCompsViaPerplexity(
  input: PerplexityCompFinderInput
): Promise<PerplexityCompFinderResult> {
  const radius = input.searchRadiusMiles ?? 1.0
  const months = input.monthsBack ?? 6
  const propType = input.subjectPropertyType ?? "single-family"

  const subjectDescription = [
    input.subjectAddress,
    input.subjectCity ? `, ${input.subjectCity}` : "",
    input.subjectState ? `, ${input.subjectState}` : "",
    input.subjectZip ? ` ${input.subjectZip}` : "",
  ]
    .join("")
    .trim()

  const subjectFeatures = [
    input.subjectBeds != null ? `${input.subjectBeds} bed` : null,
    input.subjectBaths != null ? `${input.subjectBaths} bath` : null,
    input.subjectSqft != null ? `${input.subjectSqft} sqft` : null,
    input.subjectYearBuilt != null ? `built ${input.subjectYearBuilt}` : null,
  ]
    .filter(Boolean)
    .join(" / ")

  const arvAddendum = input.arvMode
    ? "\n\nINVESTOR ARV MODE: Find the BEST-condition (recently renovated, " +
      "high-finish) comparable closed sales in the area. The subject is " +
      "being evaluated for its post-renovation value. Skip distressed/REO/ " +
      "tear-down comps — only updated/move-in-ready properties."
    : ""

  const prompt = `You are a real estate analyst pulling comparable sales for a sales-comparison CMA.

SUBJECT PROPERTY:
  Address: ${subjectDescription}
  ${subjectFeatures ? `Features: ${subjectFeatures}` : ""}
  Type: ${propType}

TASK:
Search Redfin, Zillow, Realtor.com, and public county records for comparable
${propType} properties that match the subject's bed/bath/sqft profile within
${radius} mile of the subject address.

Return:
  - 3 CLOSED comps that sold within the last ${months} months
  - 1 PENDING comp (under contract, not yet closed)
  - 1 ACTIVE comp (currently for sale)

For each comp, capture: full address, sale/list price, sale/list date, beds,
baths, sqft, lot size (acres), year built, garage spaces, pool (yes/no),
waterfront (yes/no), notable view (yes/no), property condition grade (1-5
with 1=poor 5=excellent), days on market.

Pick the comps with the closest sqft and bed/bath count to the subject —
prioritize same property type (${propType}).${arvAddendum}

OUTPUT FORMAT — strict JSON only, no prose:
{
  "closed_comps": [ { ... }, { ... }, { ... } ],
  "pending_comp": { ... } | null,
  "active_comp": { ... } | null,
  "citations": [ "url1", "url2", ... ]
}

Each comp object:
{
  "address": "123 Main St, City, State Zip",
  "status": "closed" | "pending" | "active",
  "sale_price": 450000,        // closed/pending → price; active → list price
  "sale_date": "2024-09-15",   // closed → close date; pending → contract date; active → list date
  "beds": 3,
  "full_baths": 2,
  "half_baths": 1,
  "sqft": 1800,
  "lot_size_acres": 0.25,
  "year_built": 2005,
  "garage_spaces": 2,
  "has_pool": false,
  "is_waterfront": false,
  "has_view": false,
  "condition_grade": 4,
  "is_new_construction": false,
  "is_gated": false,
  "basement_finished": false,
  "days_on_market": 18,
  "similarity_score": 0.85,    // your assessment 0-1 of how similar to subject
  "citation": "https://..."
}

Return JSON only.`

  const { text } = await generateTextRouted({
    feature: "pricing_research",  // routes to perplexity-sonar per lib/ai/models.ts:98
    prompt,
    temperature: 0.2,
    maxTokens: 4000,
  })

  return parseCompResult(text, prompt, input.arvMode ?? false)
}

function parseCompResult(
  raw: string,
  searchQuery: string,
  arvMode: boolean
): PerplexityCompFinderResult {
  // Strip code fences if present
  const cleaned = raw
    .replace(/```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()

  let parsed: {
    closed_comps?: RawComp[]
    pending_comp?: RawComp | null
    active_comp?: RawComp | null
    citations?: string[]
  } = {}

  try {
    // Find the first { ... } block
    const match = cleaned.match(/\{[\s\S]*\}/)
    parsed = match ? JSON.parse(match[0]) : {}
  } catch {
    parsed = {}
  }

  return {
    closedComps: (parsed.closed_comps ?? []).slice(0, 3).map(toScoredComp),
    pendingComp: parsed.pending_comp ? toScoredComp(parsed.pending_comp) : null,
    activeComp: parsed.active_comp ? toScoredComp(parsed.active_comp) : null,
    citations: parsed.citations ?? [],
    searchQuery,
    rawAnalysis: raw,
    arvMode,
  }
}

interface RawComp {
  address?: string
  status?: "closed" | "pending" | "active"
  sale_price?: number
  sale_date?: string
  beds?: number
  full_baths?: number
  half_baths?: number
  sqft?: number
  lot_size_acres?: number
  year_built?: number
  garage_spaces?: number
  has_pool?: boolean
  is_waterfront?: boolean
  has_view?: boolean
  condition_grade?: number
  is_new_construction?: boolean
  is_gated?: boolean
  basement_finished?: boolean
  days_on_market?: number
  similarity_score?: number
  citation?: string
}

function toScoredComp(c: RawComp): ScoredComp {
  return {
    address: c.address ?? "Unknown",
    status: c.status ?? "closed",
    salePrice: c.sale_price ?? 0,
    saleDate: c.sale_date ?? new Date().toISOString().slice(0, 10),
    sqftLiving: c.sqft ?? null,
    bedrooms: c.beds ?? null,
    fullBaths: c.full_baths ?? null,
    halfBaths: c.half_baths ?? null,
    garageSpaces: c.garage_spaces ?? null,
    hasPool: c.has_pool ?? null,
    isWaterfront: c.is_waterfront ?? null,
    hasView: c.has_view ?? null,
    lotSizeAcres: c.lot_size_acres ?? null,
    yearBuilt: c.year_built ?? null,
    conditionGrade: c.condition_grade ?? null,
    basementFinished: c.basement_finished ?? null,
    isNewConstruction: c.is_new_construction ?? null,
    isGated: c.is_gated ?? null,
    daysOnMarket: c.days_on_market ?? null,
    pricePerSqft:
      c.sale_price && c.sqft && c.sqft > 0 ? Math.round(c.sale_price / c.sqft) : null,
    similarityScore: c.similarity_score ?? 0.5,
    citation: c.citation ?? null,
  }
}
