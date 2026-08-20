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
 *
 * ─── THE RENT FIGURES ARE NOT WRITTEN BY THE MODEL ANY MORE ─────────────────
 * Investor mode used to ask the LLM for `estimatedMonthlyRent` and a
 * `rentComps[]` array — street addresses AND dollar rents, authored by a
 * generative model and rendered on an agent-branded public page under the
 * heading "Investor Metrics". That is the same defect class the CMA lane had
 * just removed (a model authored a listing price and it reached a licensed
 * appraiser), arriving through a different door: a model that invents a rent
 * also invents the three comparables that "support" it, and the failure is
 * invisible because the streets are real and the numbers are plausible.
 *
 * Rent now comes from RentCast's long-term rental listings via
 * lib/property/rent-estimate.ts — the median ASKING rent of comparable homes
 * actually published nearby, with every row it was computed from carried along
 * so the figure can be checked rather than believed. When no provider rent is
 * available the rent reads as MISSING: null, plus a plain-language note. It is
 * never replaced with a model's guess and never with a fraction of the value.
 *
 * The four income-approach ratios (cap rate, gross yield, cash-on-cash, DSCR)
 * were removed from the prompt for the same reason. Deleting only the rent line
 * would have left a model computing all four from a rent it still invented
 * privately — the fabrication would simply have stopped being visible. They are
 * now ARITHMETIC, computed here from the provider rent and this report's own
 * value estimate under stated assumptions, and they are null whenever either
 * input is.
 *
 * STILL MODEL-AUTHORED, AND SAID SO RATHER THAN QUIETLY LEFT: `estimatedValue`,
 * the comparable SALES, `arv` and `estimatedRehab`. This whole engine is an LLM
 * valuation; the rent lane changed the rent. See INVESTOR_DERIVATION_NOTE, which
 * every surface showing these ratios must show with them.
 */

import { generateTextRouted } from "@/lib/ai/models"
import {
  estimateMonthlyRentFromComps,
  type ProviderRentEstimate,
} from "./rent-estimate"

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
  /** PROVIDER-SOURCED. The median asking rent on `rentSource`, or null when no
   *  provider could serve one. Never a model's figure, never 0. */
  estimatedMonthlyRent: number | null
  /** The labelled provider result behind `estimatedMonthlyRent` and `rentComps`.
   *  ALWAYS PRESENT — when no rent could be sourced it is `available: false`
   *  with a plain-language `unavailableNote`. A surface that shows a rent MUST
   *  show this object's `label`, and a surface with no rent to show must show
   *  the note rather than nothing. */
  rentSource: ProviderRentEstimate
  capRate: number | null              // %   — computed here, see INVESTOR_DERIVATION_NOTE
  grossYield: number | null           // %   — computed here
  cashOnCashReturn: number | null     // %   — computed here (25% down @ 8%, 30yr)
  /** STILL MODEL-AUTHORED. Reported, not fixed by the rent lane. */
  arv: number | null                  // After Repair Value
  /** STILL MODEL-AUTHORED. Reported, not fixed by the rent lane. */
  estimatedRehab: number | null
  dscr: number | null                 // Debt Service Coverage Ratio — computed here
  /** The RENTAL LISTINGS the rent was measured over — real published listings
   *  from the data provider, not comparables an LLM named. Empty when none were
   *  available; see `rentSource.unavailableNote` for why. */
  rentComps: Array<{
    address: string
    monthlyRent: number
    sqft: number | null
    beds: number | null
  }>
  /** The sentence a surface must show beside the four ratios. */
  derivationNote: string
}

/**
 * WHAT THE INCOME RATIOS ARE MADE OF. Shown with them, always.
 *
 * They combine a MEASURED rent (provider-published asking rents) with an
 * ESTIMATED value (this report's own automated estimate, derived from
 * model-selected comparables). That mixture is worth stating plainly: the rent
 * half is checkable and the value half is not, and a reader who assumes both
 * halves are measurements will over-trust the result.
 */
// NOT exported, deliberately, and the census is what settled it. Its ONLY consumer
// is the private builder below (`derivationNote: INVESTOR_DERIVATION_NOTE`), which
// puts the sentence on the investor block as DATA — so every renderer already
// receives it without importing this name, and no other file ever did. An export
// nothing imports is a public surface with no consumer: it invites a second copy
// of the sentence to drift into existence somewhere else, on a page whose numbers
// are computed from different assumptions than the ones this text describes.
// The constant itself is untouched and its behaviour is identical; only the
// unused module surface is gone.
const INVESTOR_DERIVATION_NOTE =
  "Cap rate, gross yield, cash-on-cash and DSCR are calculated here from two inputs: the provider-sourced median asking rent shown above, and this report's own estimated value. The value estimate is automated and is not an appraisal, so treat these ratios as directional. Assumptions used: a 35% operating-expense ratio for single-family (45% for multi-family), and financing at 25% down, 8% interest, 30-year amortization. They are assumptions, not quotes."

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
  /**
   * The tenant a RENTAL-COMP lookup is gated, metered and billed against.
   *
   * OPTIONAL, and its absence is not silent: the rent provider is platform-gated
   * per tenant, so with no brokerage no lookup is issued and `investor
   * .rentSource` comes back `available: false` with a note saying it was a
   * wiring gap rather than an empty market. Nothing is estimated in its place.
   *
   * MUST BE RESOLVED SERVER-SIDE FROM SOMETHING THE CALLER PROVED, never taken
   * from a browser: `app/actions/property-evaluation.ts` is a public endpoint,
   * so a caller-named brokerage would let anyone spend another tenant's RentCast
   * budget. That action resolves it from the agent id the public page is built
   * around.
   */
  brokerageId?: string | null
  /** auth users.id of the agent whose page this is — lets the eligibility gate
   *  see an AGENT-tier IDX connection. Never agents.id. */
  agentUserId?: string | null
  teamId?: string | null
  /** Vendor-ledger lane. Defaults to the public home-value page's lane. */
  systemSource?: string
  /** Vendor-ledger attribution only. Never a credential selector. */
  contactId?: string | null
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

  // THE RENT, FROM A DATA PROVIDER — issued only for the audience that shows it,
  // because a rental-listing pull costs the tenant money and a homeowner's value
  // estimate does not display a rent. Resolved in PARALLEL with nothing: it runs
  // after the model call rather than beside it so a model failure does not leave
  // a paid provider call already in flight for a report that will not render.
  const rentSource: ProviderRentEstimate | null =
    audience === "investor"
      ? await estimateMonthlyRentFromComps({
          brokerageId: params.brokerageId ?? null,
          agentUserId: params.agentUserId ?? null,
          teamId: params.teamId ?? null,
          contactId: params.contactId ?? null,
          city: params.city,
          state: params.state,
          zip: params.zip ?? null,
          // The model's own read of the subject's bed count, when it produced
          // one. Used ONLY to narrow the rental search to the same bed count —
          // it never becomes a rent, and a wrong bed count costs a wider sample,
          // not a wrong number.
          bedrooms: typeof parsed?.beds === "number" ? parsed.beds : null,
          bathroomsMin: null,
          propertyType: typeof parsed?.propertyType === "string" ? parsed.propertyType : null,
          systemSource: params.systemSource ?? "home_value_investor_report",
        })
      : null

  // Build the result with defensive defaults
  return assembleEvaluation({
    parsed,
    address: params.address,
    city: params.city,
    state: params.state,
    zip: params.zip,
    audience,
    rentSource,
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

  // WHAT THE MODEL IS NO LONGER ASKED FOR, and why the prohibition is written
  // into the prompt rather than only enforced on the way out:
  //
  //   · monthly market rent          → a data provider answers this (RentCast
  //                                    long-term rental listings). A model's
  //                                    rent is a guess wearing a dollar sign.
  //   · rental comparables           → same. Model-named addresses with
  //                                    model-named rents are the "supporting
  //                                    evidence" for the guess above.
  //   · cap rate / gross yield /     → all four are rent÷value arithmetic. Left
  //     cash-on-cash / DSCR            in the prompt they would be computed from
  //                                    a rent the model still invented but no
  //                                    longer showed, which is worse: the same
  //                                    fabrication with the evidence deleted.
  //                                    They are computed in assembleEvaluation.
  //
  // The instruction is stated to the model AS WELL as enforced by the parser
  // because a model that volunteers an `estimatedMonthlyRent` field wastes
  // tokens and, more importantly, produces a response a future reader may wire
  // back up by accident. ARV and rehab are still asked for — see the file header.
  const investorBlock =
    audience === "investor"
      ? `

INVESTOR ANALYSIS (audience=investor):
- Estimate ARV (After Repair Value) and rehab budget if the property appears to need work

DO NOT ESTIMATE RENT. Do not return a monthly rent, a rental comparable, a cap
rate, a gross yield, a cash-on-cash return or a DSCR. Rental figures for this
report come from a licensed rental-listing data provider, and the return ratios
are calculated from that provider's figure. A rent you estimate would be
presented to a client as market data, so there is no field for one and any you
supply will be discarded.
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
    "arv": <int|null>,
    "estimatedRehab": <int|null>
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
  /** The provider result. Non-null exactly when audience === "investor". */
  rentSource: ProviderRentEstimate | null
}): PropertyEvaluation {
  const { parsed, address, city, state, zip, audience, rentSource } = params

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

  // The citation now says WHERE the rental half came from, and says so
  // differently when it came from nowhere. "rental market data" was printed
  // unconditionally while the rents were being written by a language model.
  const rentalCitation =
    audience !== "investor"
      ? "comparable sales"
      : rentSource?.available
        ? `comparable sales, and ${rentSource.sampleSize} comparable rental listing${
            rentSource.sampleSize === 1 ? "" : "s"
          } published by RentCast`
        : "comparable sales (no rental-listing data was available for this property — see the investor section)"

  const disclosures: PropertyDisclosures = {
    avmDisclosure: STANDARD_AVM_DISCLOSURE,
    stateSpecific: stateSpecificDisclosures,
    fairHousing: FAIR_HOUSING_DISCLOSURE,
    dataSourceCitation: `Public records, recent sales data, and ${rentalCitation}. Estimate generated ${new Date().toLocaleDateString()}.`,
  }

  const estimatedValue: number | null =
    confidence === "insufficient_data" ? null : parsed?.estimatedValue ?? null

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
    estimatedValue,
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
    // INVESTOR METRICS ARE BUILT WHENEVER THE AUDIENCE ASKED FOR THEM, not only
    // when the MODEL happened to return an `investor` object. The old condition
    // was `audience === "investor" && parsed?.investor` — so a model that
    // omitted the block (or a model call that failed entirely) produced
    // `investor: null`, and the surface simply rendered no investor section at
    // all. That is the silent-omission failure: the reader cannot tell "we could
    // not source this" from "you did not ask". The rent lookup happens whether
    // or not the model answered, so its result is reported whether or not the
    // model answered.
    investor:
      audience === "investor"
        ? buildInvestorMetrics(parsed?.investor ?? null, rentSource, estimatedValue, parsed?.propertyType ?? null)
        : null,
    disclosures,
    sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// The income approach — arithmetic over a MEASURED rent and an ESTIMATED value
// ---------------------------------------------------------------------------

/** Operating-expense ratios named once, matching what the prompt used to state. */
const EXPENSE_RATIO_MULTI_FAMILY = 0.45
const EXPENSE_RATIO_DEFAULT = 0.35
/** Financing assumptions the cash-on-cash and DSCR figures rest on. */
const DOWN_PAYMENT_PCT = 0.25
const MORTGAGE_RATE_PCT = 8
const MORTGAGE_TERM_YEARS = 30

/** Level monthly payment on a fully amortizing loan. Pure; 0 principal → 0. */
function monthlyPayment(principal: number, annualRatePct: number, years: number): number {
  if (principal <= 0) return 0
  const r = annualRatePct / 100 / 12
  const n = years * 12
  if (r === 0) return principal / n
  return (principal * r) / (1 - Math.pow(1 + r, -n))
}

/**
 * Build the investor block.
 *
 * EVERY RENT-DERIVED FIGURE IS NULL UNLESS BOTH INPUTS EXIST. No provider rent,
 * or no value estimate (the quality gate nulled it), means no cap rate, no gross
 * yield, no cash-on-cash and no DSCR — not a zero, not a figure computed against
 * a substituted number. `rentSource` always rides along carrying the reason.
 */
function buildInvestorMetrics(
  modelInvestor: any,
  rentSource: ProviderRentEstimate | null,
  estimatedValue: number | null,
  propertyType: string | null,
): InvestorMetrics {
  // `rentSource` is non-null for the investor audience by construction; the
  // fallback exists so this function has no branch that can produce a rent
  // without a source object attached to it.
  const source: ProviderRentEstimate = rentSource ?? {
    kind: "provider_sourced_rent_comps",
    provider: "rentcast",
    label: "",
    available: false,
    monthlyRent: null,
    rangeLow: null,
    rangeHigh: null,
    sampleSize: 0,
    comps: [],
    unavailableNote:
      "no rental-comparable lookup was performed for this report, so no rent is shown. Nothing was estimated in its place.",
    unavailableReason: "no_tenant",
    eligibilityReason: null,
  }

  const rent = source.monthlyRent
  const value = typeof estimatedValue === "number" && estimatedValue > 0 ? estimatedValue : null

  let capRate: number | null = null
  let grossYield: number | null = null
  let cashOnCashReturn: number | null = null
  let dscr: number | null = null

  if (rent != null && value != null) {
    const annualRent = rent * 12
    const expenseRatio =
      (propertyType ?? "").toLowerCase() === "multi_family"
        ? EXPENSE_RATIO_MULTI_FAMILY
        : EXPENSE_RATIO_DEFAULT
    const noi = annualRent * (1 - expenseRatio)
    const annualDebtService =
      monthlyPayment(value * (1 - DOWN_PAYMENT_PCT), MORTGAGE_RATE_PCT, MORTGAGE_TERM_YEARS) * 12

    capRate = Number(((noi / value) * 100).toFixed(2))
    grossYield = Number(((annualRent / value) * 100).toFixed(2))
    cashOnCashReturn = Number((((noi - annualDebtService) / (value * DOWN_PAYMENT_PCT)) * 100).toFixed(2))
    dscr = annualDebtService > 0 ? Number((noi / annualDebtService).toFixed(2)) : null
  }

  return {
    estimatedMonthlyRent: rent,
    rentSource: source,
    capRate,
    grossYield,
    cashOnCashReturn,
    // Still the model's, and the file header says so. Null rather than 0 when
    // absent: `numOrZero` used to turn a missing ARV into $0, which renders as a
    // confident zero rather than as an absence.
    arv: typeof modelInvestor?.arv === "number" ? modelInvestor.arv : null,
    estimatedRehab: typeof modelInvestor?.estimatedRehab === "number" ? modelInvestor.estimatedRehab : null,
    dscr,
    // Provider rows only. The model no longer produces rental comparables and
    // nothing here reads a `rentComps` field off its response.
    rentComps: source.comps.map((c) => ({
      address: c.address,
      monthlyRent: c.monthlyRent,
      sqft: c.squareFeet,
      beds: c.bedrooms,
    })),
    derivationNote: INVESTOR_DERIVATION_NOTE,
  }
}

function numOrZero(v: any): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : 0
}
