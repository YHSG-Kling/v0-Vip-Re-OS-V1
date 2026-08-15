/**
 * lib/property/property-evaluation.ts
 *
 * State-compliant property valuation engine.
 *
 * Two callers:
 *   - Public Home Value page (homeowner enters address → consumer estimate)
 *   - Agent CRM CMA tool (agent runs CMA on a contact)
 *
 * Both use the same engine with `audience: 'homeowner' | 'investor'` toggle.
 *
 * Methodology:
 *   - Sales Comparison Approach with state-specific adjustments
 *   - 3-6 comparable sales (last 6 months, 0.5–1 mile radius typical)
 *   - Adjustments per appraisal-board guidelines: time, location, GLA,
 *     beds/baths, condition, lot size
 *   - Reconciled value range with confidence level
 *   - Investor mode adds income approach (cap rate, NOI, ARV, DSCR)
 *
 * Disclosures:
 *   - Always returns an AVM disclosure (legally required in most states)
 *   - State-specific addendum where applicable
 *   - "Not an appraisal" language
 *   - Fair housing acknowledgement
 *
 * Quality gate: if comp data is too thin, returns
 *   confidenceLevel = 'insufficient_data' and recommends a manual CMA.
 */

import { generateTextRouted } from "@/lib/ai/models"

export type EvaluationAudience = "homeowner" | "investor"
export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient_data"

export interface PropertyComp {
  address: string
  salePrice: number
  saleDate: string
  distanceMiles: number | null
  sqft: number | null
  beds: number | null
  baths: number | null
  yearBuilt: number | null
  /** Dollar-value adjustments applied per appraiser methodology */
  adjustments: {
    time: number          // market appreciation/depreciation since sale date
    location: number      // location quality differential
    sqft: number          // GLA differential
    bedBath: number       // bed/bath count differential
    condition: number     // condition differential
    other: number         // pool, garage, lot, etc.
    total: number
  }
  adjustedSalePrice: number
}

export interface InvestorMetrics {
  estimatedMonthlyRent: number | null
  capRate: number | null              // %
  grossYield: number | null           // %
  cashOnCashReturn: number | null     // %  (assumes 25% down @ 8% rate)
  arv: number | null                  // After Repair Value
  estimatedRehab: number | null
  dscr: number | null                 // Debt Service Coverage Ratio
  rentComps: Array<{
    address: string
    monthlyRent: number
    sqft: number | null
    beds: number | null
  }>
}

export interface PropertyDisclosures {
  /** Universal AVM-vs-appraisal disclosure (required in nearly every state) */
  avmDisclosure: string
  /** State-specific addendum (e.g. CA requires specific language) */
  stateSpecific: string[]
  /** Fair Housing acknowledgement */
  fairHousing: string
  /** Data sources used (transparency) */
  dataSourceCitation: string
}

export interface PropertyEvaluation {
  // Core property facts
  address: string
  city: string | null
  state: string | null
  zip: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  yearBuilt: number | null
  lotSizeAcres: number | null
  propertyType: string | null

  // Valuation
  estimatedValue: number | null
  valueRangeLow: number | null
  valueRangeHigh: number | null
  confidenceLevel: ConfidenceLevel

  // Comparables with adjustments
  comparables: PropertyComp[]

  // Pricing strategy (for sellers)
  recommendedListPrice: number | null
  quickSalePrice: number | null         // 7-day sale price
  premiumPrice: number | null           // ambitious top-of-range
  daysOnMarketEstimate: number | null

  // Methodology used
  methodology: {
    approach: "sales_comparison" | "income" | "cost" | "reconciliation"
    compsConsidered: number
    timeframeMonths: number
    radiusMiles: number
    adjustmentBasis: string
    rationale: string
  }

  // Investor metrics (only present when audience='investor')
  investor: InvestorMetrics | null

  // Always-included disclosures
  disclosures: PropertyDisclosures

  // Provenance
  sources: string[]
  generatedAt: string
}

const STANDARD_AVM_DISCLOSURE = `
This estimate is not an appraisal and is not a guarantee of value. It is a computer-generated valuation based on publicly available property data and recent comparable sales. Only a licensed real estate appraiser can perform a formal appraisal. Actual market value depends on a property inspection, current market conditions, buyer demand, and other factors not captured in this analysis. Lenders and other institutions making financing decisions should not rely on this estimate.
`.trim()

const FAIR_HOUSING_DISCLOSURE = `
This valuation does not consider the race, color, religion, national origin, sex, familial status, or disability of any current or prospective occupants of the property. Comparable sales are selected based on physical and locational characteristics only, in compliance with the Fair Housing Act and applicable state/local fair housing laws.
`.trim()

const INSUFFICIENT_DATA_THRESHOLD = 2 // need at least 2 quality comps for any valuation

/**
 * Evaluate a property — produces a state-compliant CMA-style valuation
 * with comps, adjustments, methodology, and required disclosures.
 */
export async function evaluatePropertyValue(params: {
  address: string
  city: string
  state: string
  zip?: string
  audience?: EvaluationAudience
}): Promise<PropertyEvaluation> {
  const audience = params.audience ?? "homeowner"
  const fullAddress = [params.address, params.city, params.state, params.zip]
    .filter(Boolean)
    .join(", ")

  const prompt = buildEvaluationPrompt({ fullAddress, state: params.state, audience })

  let parsed: any = null
  try {
    const { text } = await generateTextRouted({
      feature: "home_value_estimate",
      prompt,
      maxTokens: 3000,
      temperature: 0,
    })
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch {
    parsed = null
  }

  // Build the result with defensive defaults
  return assembleEvaluation({
    parsed,
    address: params.address,
    city: params.city,
    state: params.state,
    zip: params.zip,
    audience,
  })
}

// ---------------------------------------------------------------------------
// Prompt builder — drives state-compliant methodology
// ---------------------------------------------------------------------------

function buildEvaluationPrompt(params: {
  fullAddress: string
  state: string
  audience: EvaluationAudience
}): string {
  const { fullAddress, state, audience } = params

  const investorBlock =
    audience === "investor"
      ? `

INVESTOR ANALYSIS (audience=investor):
Additionally compute the income approach:
- Estimate monthly market rent from current rental comps in the area
- Calculate cap rate (NOI / value), assuming 35% expense ratio for SFR or 45% for multi-family
- Calculate gross yield (annual rent / value)
- Calculate cash-on-cash return assuming 25% down @ 8% interest, 30-year amortization
- Estimate ARV (After Repair Value) and rehab budget if the property appears to need work
- Calculate DSCR (NOI / annual debt service)
- Find 3 rental comparables (active or recent leases within 0.5 mile, similar size)
`
      : ""

  return `
You are a real estate analyst producing a state-compliant comparative market analysis (CMA) for the property at:

${fullAddress}

Apply the SALES COMPARISON APPROACH following ${state} state appraiser/real estate commission guidelines:

1. Find 3-6 comparable sales:
   - Sold within the last 6 months (preferred) or up to 12 months
   - Within 0.5–1 mile radius
   - Similar property type, similar bed/bath count, GLA within ±25%
   - Same school district or neighborhood when possible

2. For each comp, apply dollar adjustments per appraisal methodology:
   - **Time adjustment**: ±0.3-0.6%/month for market appreciation/depreciation since sale date
   - **Location adjustment**: differential for location quality (school, view, busy street, etc.)
   - **GLA (sqft) adjustment**: typical $80-150/sqft based on local market — adjust for sqft difference
   - **Bed/bath adjustment**: ~$5,000-15,000 per bedroom, ~$5,000-12,000 per bathroom
   - **Condition adjustment**: differential for renovation status, age of systems, kitchen/bath updates
   - **Other adjustments**: pool, garage, lot size, view, HOA differential

3. Reconcile to a value range with the most-similar comps weighted higher.

4. Pricing strategy (for ${audience}):
   - recommendedListPrice (most likely sale price)
   - quickSalePrice (7-day sale, typically 92-95% of recommended)
   - premiumPrice (top of range, requires ideal conditions)
   - daysOnMarketEstimate (typical for area at recommended price)

${investorBlock}

QUALITY GATE: If you cannot find at least 2 reasonable comparable sales, set confidenceLevel="insufficient_data" and explain in rationale that a manual CMA is recommended. Do NOT fabricate comps.

STATE COMPLIANCE: For ${state}, include any state-specific disclosure language required for AVMs/CMAs in the stateSpecific array (e.g., licensing language, time-validity statements). If unsure, return an empty array.

Return ONLY this JSON shape (use null for unknowns; use empty arrays where appropriate):

{
  "city": <string|null>,
  "state": "${state}",
  "zip": <string|null>,
  "beds": <int|null>,
  "baths": <number|null>,
  "sqft": <int|null>,
  "yearBuilt": <int|null>,
  "lotSizeAcres": <number|null>,
  "propertyType": <"single_family"|"condo"|"townhouse"|"multi_family"|"land"|null>,
  "estimatedValue": <int|null>,
  "valueRangeLow": <int|null>,
  "valueRangeHigh": <int|null>,
  "confidenceLevel": <"high"|"medium"|"low"|"insufficient_data">,
  "comparables": [
    {
      "address": <string>,
      "salePrice": <int>,
      "saleDate": <"YYYY-MM-DD">,
      "distanceMiles": <number|null>,
      "sqft": <int|null>,
      "beds": <int|null>,
      "baths": <number|null>,
      "yearBuilt": <int|null>,
      "adjustments": {
        "time": <int>, "location": <int>, "sqft": <int>,
        "bedBath": <int>, "condition": <int>, "other": <int>, "total": <int>
      },
      "adjustedSalePrice": <int>
    }
  ],
  "recommendedListPrice": <int|null>,
  "quickSalePrice": <int|null>,
  "premiumPrice": <int|null>,
  "daysOnMarketEstimate": <int|null>,
  "methodology": {
    "approach": <"sales_comparison"|"income"|"cost"|"reconciliation">,
    "compsConsidered": <int>,
    "timeframeMonths": <int>,
    "radiusMiles": <number>,
    "adjustmentBasis": <string>,
    "rationale": <string explaining why this value, in 2-3 sentences>
  },
  ${
    audience === "investor"
      ? `"investor": {
    "estimatedMonthlyRent": <int|null>,
    "capRate": <number|null>,
    "grossYield": <number|null>,
    "cashOnCashReturn": <number|null>,
    "arv": <int|null>,
    "estimatedRehab": <int|null>,
    "dscr": <number|null>,
    "rentComps": [
      {"address": <string>, "monthlyRent": <int>, "sqft": <int|null>, "beds": <int|null>}
    ]
  },`
      : `"investor": null,`
  }
  "stateSpecificDisclosures": [<string>, ...],
  "sources": [<string>, ...]
}

Respond with ONLY the JSON. No explanation, no markdown.
`.trim()
}

// ---------------------------------------------------------------------------
// Result assembler — defensive defaults, applies disclosures, gates output
// ---------------------------------------------------------------------------

function assembleEvaluation(params: {
  parsed: any
  address: string
  city: string
  state: string
  zip?: string
  audience: EvaluationAudience
}): PropertyEvaluation {
  const { parsed, address, city, state, zip, audience } = params

  const compArr: PropertyComp[] = Array.isArray(parsed?.comparables)
    ? parsed.comparables.map((c: any) => ({
        address: c?.address ?? "",
        salePrice: numOrZero(c?.salePrice),
        saleDate: c?.saleDate ?? "",
        distanceMiles: c?.distanceMiles ?? null,
        sqft: c?.sqft ?? null,
        beds: c?.beds ?? null,
        baths: c?.baths ?? null,
        yearBuilt: c?.yearBuilt ?? null,
        adjustments: {
          time: numOrZero(c?.adjustments?.time),
          location: numOrZero(c?.adjustments?.location),
          sqft: numOrZero(c?.adjustments?.sqft),
          bedBath: numOrZero(c?.adjustments?.bedBath),
          condition: numOrZero(c?.adjustments?.condition),
          other: numOrZero(c?.adjustments?.other),
          total: numOrZero(c?.adjustments?.total),
        },
        adjustedSalePrice: numOrZero(c?.adjustedSalePrice),
      }))
    : []

  // Quality gate: under threshold → confidence='insufficient_data'
  let confidence: ConfidenceLevel =
    parsed?.confidenceLevel === "high" ||
    parsed?.confidenceLevel === "medium" ||
    parsed?.confidenceLevel === "low" ||
    parsed?.confidenceLevel === "insufficient_data"
      ? parsed.confidenceLevel
      : "low"

  if (compArr.length < INSUFFICIENT_DATA_THRESHOLD) {
    confidence = "insufficient_data"
  }

  const stateSpecificDisclosures: string[] = Array.isArray(parsed?.stateSpecificDisclosures)
    ? parsed.stateSpecificDisclosures.filter((s: any) => typeof s === "string")
    : []

  const disclosures: PropertyDisclosures = {
    avmDisclosure: STANDARD_AVM_DISCLOSURE,
    stateSpecific: stateSpecificDisclosures,
    fairHousing: FAIR_HOUSING_DISCLOSURE,
    dataSourceCitation: `Public records, recent sales data, and ${
      audience === "investor" ? "rental market data" : "comparable sales"
    }. Estimate generated ${new Date().toLocaleDateString()}.`,
  }

  return {
    address,
    city: parsed?.city ?? city ?? null,
    state: parsed?.state ?? state ?? null,
    zip: parsed?.zip ?? zip ?? null,
    beds: parsed?.beds ?? null,
    baths: parsed?.baths ?? null,
    sqft: parsed?.sqft ?? null,
    yearBuilt: parsed?.yearBuilt ?? null,
    lotSizeAcres: parsed?.lotSizeAcres ?? null,
    propertyType: parsed?.propertyType ?? null,
    estimatedValue: confidence === "insufficient_data" ? null : parsed?.estimatedValue ?? null,
    valueRangeLow: confidence === "insufficient_data" ? null : parsed?.valueRangeLow ?? null,
    valueRangeHigh: confidence === "insufficient_data" ? null : parsed?.valueRangeHigh ?? null,
    confidenceLevel: confidence,
    comparables: compArr,
    recommendedListPrice: parsed?.recommendedListPrice ?? null,
    quickSalePrice: parsed?.quickSalePrice ?? null,
    premiumPrice: parsed?.premiumPrice ?? null,
    daysOnMarketEstimate: parsed?.daysOnMarketEstimate ?? null,
    methodology: {
      approach: parsed?.methodology?.approach ?? "sales_comparison",
      compsConsidered: parsed?.methodology?.compsConsidered ?? compArr.length,
      timeframeMonths: parsed?.methodology?.timeframeMonths ?? 6,
      radiusMiles: parsed?.methodology?.radiusMiles ?? 1,
      adjustmentBasis: parsed?.methodology?.adjustmentBasis ?? `${state} appraisal guidelines`,
      rationale:
        parsed?.methodology?.rationale ??
        (confidence === "insufficient_data"
          ? "Insufficient comparable sales data — recommend a manual CMA from your agent."
          : ""),
    },
    investor:
      audience === "investor" && parsed?.investor
        ? {
            estimatedMonthlyRent: parsed.investor.estimatedMonthlyRent ?? null,
            capRate: parsed.investor.capRate ?? null,
            grossYield: parsed.investor.grossYield ?? null,
            cashOnCashReturn: parsed.investor.cashOnCashReturn ?? null,
            arv: parsed.investor.arv ?? null,
            estimatedRehab: parsed.investor.estimatedRehab ?? null,
            dscr: parsed.investor.dscr ?? null,
            rentComps: Array.isArray(parsed.investor.rentComps)
              ? parsed.investor.rentComps.map((r: any) => ({
                  address: r?.address ?? "",
                  monthlyRent: numOrZero(r?.monthlyRent),
                  sqft: r?.sqft ?? null,
                  beds: r?.beds ?? null,
                }))
              : [],
          }
        : null,
    disclosures,
    sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
    generatedAt: new Date().toISOString(),
  }
}

function numOrZero(v: any): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : 0
}
