"use server"

import { createClient } from "@/lib/supabase/server"
import { generateAIJSON } from "@/lib/ai"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { checkPublicRateLimit, publicCallerIp } from "@/lib/security/public-rate-limit"

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC-SURFACE ABUSE BOUNDS FOR THE LOGGED-OUT CALCULATORS
//
// OWNER RULING: rate-limit, keep it open. The zero-friction public calculator is
// the lead-gen funnel and it stays anonymous — `tool_usage_sessions_insert` is a
// DELIBERATE, NAMED anon carve-out (m394 `keep_anon_insert`, carried forward by
// m396 and asserted by m395/m397) and is not touched here. What is bounded is the
// volume and the size of what an anonymous caller can push through it.
//
// REUSE, NOT A SECOND LIMITER. `lib/security/public-rate-limit.ts` already exists
// and already fronts signup, the get-started coupon probe and the embed widget.
// Its honesty note applies unchanged: it is a per-instance fixed-window counter,
// so the real ceiling is (limit × warm instances). That stops a tight abuse loop,
// which is the exposure here; it is not a distributed quota.
//
// 🚩 DEGRADATION IS DELIBERATELY OPEN, NOT CLOSED — this is the one surface in the
// tree where that is the correct posture, and it is the owner's explicit ruling.
// A limiter outage must not take down a public marketing page. So:
//   · over the limit  → REJECT THE WRITE, still return the computed result;
//   · limiter itself unavailable/throwing → ALLOW, and say so on the console.
// Everything the limiter guards here is analytics or a convenience save. Nothing
// behind it is an authorization decision, and no gate in this file is implemented
// with it — gates elsewhere in the tree fail CLOSED and must keep doing so.
// ─────────────────────────────────────────────────────────────────────────────

/** Largest `session_data_json` / persisted payload we will store, in bytes. */
const MAX_PERSISTED_PAYLOAD_BYTES = 8 * 1024
/** Longest caller-supplied text we will put in an unbounded `text` column. */
const MAX_PUBLIC_TEXT_CHARS = 200

const PUBLIC_CALC_LIMITS = {
  /** Analytics pings. Generous — a real visitor clicking through tools trips several. */
  toolUsage: { limit: 30, windowMs: 60_000 },
  /** Persisted saves, keyed to a visitor id. NOT a logged-out lane despite this
   *  block's heading — `saveCalculation` is reached only from the signed-in
   *  dashboard and now requires a session to resolve its tenant. The per-IP bound
   *  stays because the endpoint is still a reachable `"use server"` export. */
  saveCalculation: { limit: 10, windowMs: 60_000 },
  /** Outbound mail. Tightest — the platform's sending reputation is on the line. */
  emailResults: { limit: 5, windowMs: 60_000 },
  /** Paid comp providers + an LLM call per invocation. Tight for spend, not for abuse alone. */
  homeValue: { limit: 5, windowMs: 60_000 },
} as const

/**
 * Per-IP verdict for one public calculator surface.
 *
 * NEVER THROWS. The limiter is in-process and `publicCallerIp()` already swallows
 * a missing request scope, but this wrapper is what makes the open-degradation
 * ruling above true BY CONSTRUCTION rather than by hoping nothing raises.
 */
async function publicCalcRateVerdict(
  surface: keyof typeof PUBLIC_CALC_LIMITS,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  try {
    const ip = await publicCallerIp()
    return checkPublicRateLimit(`calculators:${surface}`, ip, PUBLIC_CALC_LIMITS[surface])
  } catch (e) {
    // DEGRADE OPEN — see the ruling above. Recorded, never silent.
    console.error(`[calculators] rate limiter unavailable for "${surface}", allowing:`, e)
    return { allowed: true, retryAfterSeconds: 0 }
  }
}

/**
 * Bound a caller-supplied JSON payload before it reaches a jsonb column.
 *
 * The inputs objects handed to `trackToolUsage` are whatever the client posted —
 * `calculateAffordability` and `calculateRentVsBuy` forward their ENTIRE `data`
 * argument — so without this an anonymous caller sets the row size, not us.
 * Oversize payloads are REPLACED by a stub rather than dropping the row: the
 * analytics fact ("this tool was used") survives; the unbounded blob does not.
 */
function boundPersistedPayload(payload: unknown): unknown {
  let serialized: string
  try {
    serialized = JSON.stringify(payload) ?? ""
  } catch {
    // Cyclic or otherwise unserializable — it was never going to reach jsonb.
    return { omitted: true, reason: "unserializable" }
  }
  if (serialized.length <= MAX_PERSISTED_PAYLOAD_BYTES) return payload
  return {
    omitted: true,
    reason: "payload_too_large",
    bytes: serialized.length,
    limit_bytes: MAX_PERSISTED_PAYLOAD_BYTES,
  }
}

/** Bound a caller-supplied string headed for an unbounded `text` column. */
function boundPublicText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, MAX_PUBLIC_TEXT_CHARS)
}

// ============================================
// SELLER NET PROCEEDS CALCULATOR
// ============================================

/**
 * TOMBSTONE — `getLocalTitleCost(location, homeValue)` and
 * `getLocalEscrowFees(location, homeValue)` stood here. Both accepted `location` and
 * read NOT ONE CHARACTER of it while returning a flat national percentage, so the
 * word "Local" in the name was the only local thing about the number — and this
 * number is printed to a SELLER as their title insurance and escrow cost.
 *
 * The parameter is deleted rather than wired because wiring it would mean inventing a
 * per-jurisdiction rate table, and a fabricated rate presented as local is a worse
 * defect than an honest national estimate. Renamed so the name states what the number
 * actually is. The place where jurisdiction genuinely does move the figure is
 * `calculateTransferTax(homeValue, state)` directly below, which carries a real
 * per-state table — that is the survivor of the "local" idea in this file, and the
 * shape any future title/escrow table should follow.
 */
async function estimateTitleInsuranceNational(homeValue: number): Promise<number> {
  // Title insurance typically ranges from 0.5% to 1% of home value (national typical).
  return homeValue * 0.007
}

async function estimateEscrowFeesNational(homeValue: number): Promise<number> {
  // Escrow fees typically range from 1-2% of home value (national typical).
  return homeValue * 0.015
}

function calculateTransferTax(homeValue: number, state: string): number {
  const transferTaxRates: Record<string, number> = {
    TX: 0, // Texas has no state transfer tax
    CA: homeValue * 0.0011, // $1.10 per $1,000
    FL: homeValue * 0.007, // $0.70 per $100
    NY: homeValue * 0.004, // $4 per $1,000
  }

  return transferTaxRates[state] || homeValue * 0.001
}

export async function calculateSellerNet(data: {
  homeValue: number
  mortgageBalance: number
  location: string
  state: string
  hoaFees?: number
  repairsConcessions?: number
  stagingCost?: number
  movingCost?: number
  brokerageId: string
}) {
  const supabase = await createClient()

  // Get brokerage commission structure
  const commissionStructure = await getDefaultCommissionStructure(data.brokerageId)
  const totalCommissionRate = commissionStructure.agentBuyerSideRate + commissionStructure.agentListingSideRate

  const costs = {
    agent_commission: data.homeValue * totalCommissionRate,
    title_insurance: await estimateTitleInsuranceNational(data.homeValue),
    escrow_fees: await estimateEscrowFeesNational(data.homeValue),
    transfer_tax: calculateTransferTax(data.homeValue, data.state),
    hoa_fees: data.hoaFees || 0,
    repairs_concessions: data.repairsConcessions || data.homeValue * 0.02, // Default 2%
    staging: data.stagingCost || 0,
    moving: data.movingCost || 2000,
  }

  const totalCosts = Object.values(costs).reduce((a, b) => a + b, 0)
  const netProceeds = data.homeValue - data.mortgageBalance - totalCosts

  // AI-powered market scenarios
  const prompt = `You are a real estate market analyst. Predict appreciation scenarios:

Home Value: $${data.homeValue.toLocaleString()}
Location: ${data.location}, ${data.state}
Current Net Proceeds: $${netProceeds.toLocaleString()}

Predict realistic scenarios for:
1. Sell now (current proceeds)
2. Sell in 6 months (with market appreciation/depreciation)
3. Sell in 1 year (with market appreciation/depreciation)

Consider current market trends. Respond with JSON:

{
  "scenarios": [
    {
      "timeframe": "Sell now",
      "estimated_home_value": ${data.homeValue},
      "net_proceeds": ${netProceeds},
      "reasoning": "Current market conditions"
    },
    {
      "timeframe": "Sell in 6 months",
      "estimated_home_value": 465000,
      "net_proceeds": 95000,
      "reasoning": "Market expected to appreciate 3%",
      "market_outlook": "stable"
    },
    {
      "timeframe": "Sell in 1 year",
      "estimated_home_value": 475000,
      "net_proceeds": 105000,
      "reasoning": "Continued appreciation expected",
      "market_outlook": "bullish"
    }
  ],
  "recommendation": "Consider waiting 6 months if not urgent - market trending upward"
}`

  try {
    const aiScenarios = await generateAIJSON(prompt)

    return {
      success: true,
      home_value: data.homeValue,
      mortgage_payoff: data.mortgageBalance,
      total_costs: totalCosts,
      cost_breakdown: costs,
      net_proceeds: netProceeds,
      scenarios: aiScenarios.data?.scenarios || [],
      recommendation: aiScenarios.data?.recommendation,
    }
  } catch (error) {
    console.error("[v0] Error in calculateSellerNet:", error)
    return {
      success: true,
      home_value: data.homeValue,
      mortgage_payoff: data.mortgageBalance,
      total_costs: totalCosts,
      cost_breakdown: costs,
      net_proceeds: netProceeds,
      scenarios: [
        { timeframe: "Sell now", net_proceeds: netProceeds, estimated_home_value: data.homeValue },
      ],
    }
  }
}

// ============================================
// MORTGAGE COMPARISON CALCULATOR
// ============================================

export async function compareMortgageScenarios(data: {
  loanAmount: number
  scenarios: Array<{
    name: string
    term: number // years
    interestRate: number // percentage
    downPayment: number
    loanType: "fixed" | "arm"
  }>
}) {
  const calculateMonthlyPayment = (principal: number, rate: number, years: number) => {
    const monthlyRate = rate / 100 / 12
    const numPayments = years * 12
    return (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1)
  }

  const comparisons = data.scenarios.map((scenario) => {
    const principal = data.loanAmount - scenario.downPayment
    const monthlyPayment = calculateMonthlyPayment(principal, scenario.interestRate, scenario.term)
    const totalPaid = monthlyPayment * scenario.term * 12
    const totalInterest = totalPaid - principal

    return {
      name: scenario.name,
      loan_type: scenario.loanType,
      term_years: scenario.term,
      interest_rate: scenario.interestRate,
      down_payment: scenario.downPayment,
      loan_amount: principal,
      monthly_payment: Math.round(monthlyPayment),
      total_paid: Math.round(totalPaid),
      total_interest: Math.round(totalInterest),
      breakeven_months: scenario.downPayment > 0 ? Math.round(scenario.downPayment / monthlyPayment) : 0,
    }
  })

  const prompt = `You are a mortgage advisor. Analyze these mortgage scenarios:

${JSON.stringify(comparisons, null, 2)}

Provide recommendations for:
- First-time buyers (limited down payment)
- Buyers planning to stay 5-7 years
- Buyers planning to stay 10+ years
- Investors looking to minimize interest

Respond with JSON:
{
  "recommendations": {
    "first_time_buyers": "30-year fixed with 5% down - lowest monthly payment",
    "medium_term": "15-year fixed if can afford payment - save $50k in interest",
    "long_term": "15-year fixed - significant interest savings",
    "investors": "30-year fixed - preserve cash flow"
  },
  "winner_by_category": {
    "lowest_monthly_payment": "30-year fixed",
    "least_total_interest": "15-year fixed",
    "best_balance": "20-year fixed"
  }
}`

  try {
    const aiRecommendations = await generateAIJSON(prompt)

    return {
      success: true,
      comparisons,
      recommendations: aiRecommendations.data?.recommendations,
      winner_by_category: aiRecommendations.data?.winner_by_category,
    }
  } catch (error) {
    console.error("[v0] Error in compareMortgageScenarios:", error)
    return {
      success: true,
      comparisons,
    }
  }
}

// ============================================
// NEIGHBORHOOD COMPARISON TOOL
// ============================================

/**
 * Compare neighborhoods from the data this product actually holds.
 *
 * What this used to do: call IDX getProperties({ city, status: "sold" }) INSIDE the
 * per-neighborhood map. That function ignored every filter, so all three
 * neighborhoods received the same array of the brokerage's featured ACTIVE
 * listings, and median_price was averaged over `p.soldPrice` — a field active
 * listings do not carry — so it was always 0. Everything else on the row was a
 * hardcoded constant (school_rating 7, crime_rating "B", walkability 50, a 20
 * minute commute, "Family-friendly suburban area", and canned pros/cons). Those
 * were invented facts about real neighborhoods, handed to an AI that then told
 * families where to live. They are gone.
 *
 * What replaces them: the market_data observation table (writer:
 * lib/intelligence/market-insight-generator.ts) for sale-side figures, and the IDX
 * feed for a real active-listing count. Fields with no source are null and are
 * named in `unavailable` so the prompt — and any UI — can say "not available"
 * instead of showing a default that looks measured.
 *
 * market_data may legitimately have no row yet. That is a null, not a fallback.
 */
export async function compareNeighborhoods(neighborhoods: string[], city: string, state: string) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")

  // WHOSE feed is the active-listing count? It used to be `new IDXBrokerClient()`,
  // i.e. always the platform's IDXBROKER_API_KEY — so a brokerage that had
  // connected its own IDX Broker account was still counting somebody else's
  // listings and the row said `active_listings_source: "brokerage_idx_feed"` about
  // it. IDX Broker is tenant-settable (lib/connections/scope.ts, `listing`), so the
  // owner is RESOLVED from the session and forBrokerage walks
  // agent → team → brokerage → platform.
  //
  // With no session there is no tenant, and the answer is NOT "use the platform's
  // key": it is that this figure has no owner and therefore no source. The client
  // is null, `listings` stays null, and "active_listings" joins that entry's
  // `unavailable` list — the same treatment every other unsourced field on this row
  // already gets, which the prompt below is explicitly instructed not to paper over.
  // That is deliberately different from a resolved tenant whose cascade ends at a
  // configured platform key: that one is a real, documented final tier and does
  // produce a count.
  const idxSession = await getAgentContext()
  const idxClient =
    idxSession.isAuthenticated && idxSession.brokerageId
      ? await IDXBrokerClient.forBrokerage(idxSession.brokerageId, {
          agentUserId: idxSession.userId || null,
          // The TEAM rung of the cascade. getAgentContext already read
          // users.team_id and used to discard it, so this rung was silently
          // skipped and a team with its own IDX connection was stepped over in
          // favour of the brokerage (or platform) feed.
          teamId: idxSession.teamId,
        })
      : null
  const idxConfigured = !!idxClient && idxClient.isConfigured()

  // A neighborhood entered as a 5-digit ZIP can be matched exactly; a NAMED
  // neighborhood cannot — neither market_data nor the IDX feed carries a
  // neighborhood boundary, so the best available geography is the city.
  const asZip = (s: string) => (/^\d{5}$/.test(s.trim()) ? s.trim() : null)

  const comparison = await Promise.all(
    neighborhoods.map(async (neighborhood) => {
      const zip = asZip(neighborhood)

      let query = supabase
        .from("market_data")
        .select(
          "median_sale_price, avg_days_on_market, months_of_inventory, price_trend_pct_1yr, market_type, data_date",
        )
        .order("data_date", { ascending: false })
        .limit(1)
      query = zip ? query.eq("zip_code", zip) : query.eq("city", city).eq("state", state)

      const { data: marketRow, error: marketError } = await query.maybeSingle()
      if (marketError) {
        console.error("[v0] compareNeighborhoods: market_data read refused:", marketError.message)
      }
      const market = marketError ? null : marketRow

      // Real active-listing count, from the RESOLVED tenant's own IDX feed — the
      // signed-in brokerage's IDX-enabled active listings, not total market
      // inventory; `active_listings_source` says so. With no resolved tenant, or a
      // tenant whose cascade reaches no key at all, the search would return [],
      // which reads as a measured zero — so both cases yield null instead.
      const listings = idxClient && idxConfigured
        ? await idxClient.searchActiveListings(zip ? { zipCode: zip, state } : { city, state })
        : null

      const unavailable: string[] = [
        // No source in this system for any of these. They are not defaulted.
        "school_rating",
        "crime_rating",
        "walkability_score",
        "commute_to_downtown",
        "vibe",
        "pros",
        "cons",
      ]
      if (!market) {
        unavailable.push(
          "median_sale_price",
          "avg_days_on_market",
          "months_of_inventory",
          "price_trend_pct_1yr",
          "market_type",
        )
      }
      if (listings == null) unavailable.push("active_listings")

      return {
        name: neighborhood,
        // The geography the numbers below actually describe.
        resolved_scope: zip
          ? `ZIP ${zip}`
          : `${city}, ${state} — city-wide; no neighborhood-level data source exists, so these figures are NOT specific to "${neighborhood}"`,
        median_sale_price: market?.median_sale_price ?? null,
        avg_days_on_market: market?.avg_days_on_market ?? null,
        months_of_inventory: market?.months_of_inventory ?? null,
        price_trend_pct_1yr: market?.price_trend_pct_1yr ?? null,
        market_type: market?.market_type ?? null,
        market_data_as_of: market?.data_date ?? null,
        active_listings: listings?.length ?? null,
        active_listings_source: listings == null ? null : "brokerage_idx_feed",
        unavailable,
      }
    }),
  )

  const prompt = `You are a neighborhood analyst. Compare these areas using ONLY the
data below.

${JSON.stringify(comparison, null, 2)}

RULES — the data is deliberately sparse and you must not paper over it:
- Any field listed in that entry's "unavailable" array has NO source in this
  system. Do not estimate it, do not infer it from the area's name, and do not
  reason from it. School quality, crime, walkability, commute times and
  neighborhood "vibe" are unavailable for every entry.
- A "resolved_scope" that says city-wide means the figures describe the whole
  city, not that named neighborhood. Say so rather than attributing them to the
  neighborhood.
- "active_listings" counts one brokerage's IDX-enabled listings, not total market
  inventory. Never compute market share or absorption from it.
- If two entries resolved to the same scope, their figures are identical by
  construction and cannot distinguish them. Say that instead of picking a winner.
- If the data cannot support a recommendation for a buyer type, set "best_fit" to
  null and use "reasoning" to state exactly what would be needed.

Respond with JSON (illustrative values; null wherever unsupported):
{
  "recommendations": {
    "young_families": {"best_fit": null, "reasoning": "School, crime and park data are unavailable, which is what this comparison turns on."},
    "empty_nesters": {"best_fit": null, "reasoning": "..."},
    "first_time_buyers": {"best_fit": "...", "reasoning": "Lowest median sale price of the areas with data"},
    "investors": {"best_fit": "...", "reasoning": "..."}
  },
  "overall_winner": null,
  "best_value": null,
  "data_limitations": ["List every field you could not use and why it mattered"]
}`

  try {
    const aiSummary = await generateAIJSON(prompt)

    return {
      success: true,
      comparison,
      ai_recommendations: aiSummary.data?.recommendations,
      overall_winner: aiSummary.data?.overall_winner ?? null,
      best_value: aiSummary.data?.best_value ?? null,
      data_limitations: aiSummary.data?.data_limitations ?? null,
    }
  } catch (error) {
    console.error("[v0] Error in compareNeighborhoods:", error)
    return {
      success: true,
      comparison,
    }
  }
}

// ============================================
// INVESTMENT PROPERTY ANALYZER
// ============================================

export async function analyzeInvestmentProperty(data: {
  purchasePrice: number
  downPaymentPercent: number
  interestRate: number
  estimatedRent: number
  propertyTaxes: number
  insurance: number
  hoaFees: number
  maintenanceReserve: number // % of rent
  vacancyRate: number // % of year vacant
  address?: string
}) {
  const downPayment = data.purchasePrice * (data.downPaymentPercent / 100)
  const loanAmount = data.purchasePrice - downPayment
  const monthlyRate = data.interestRate / 100 / 12
  const numPayments = 30 * 12
  const monthlyMortgage =
    (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1)

  const monthlyExpenses =
    monthlyMortgage +
    data.propertyTaxes / 12 +
    data.insurance / 12 +
    data.hoaFees +
    data.estimatedRent * (data.maintenanceReserve / 100)

  const annualRent = data.estimatedRent * 12 * (1 - data.vacancyRate / 100)
  const annualExpenses = monthlyExpenses * 12
  const netOperatingIncome = annualRent - annualExpenses + monthlyMortgage * 12 // Add back mortgage for NOI
  const capRate = (netOperatingIncome / data.purchasePrice) * 100
  const cashFlow = annualRent - annualExpenses
  const cashOnCashReturn = (cashFlow / downPayment) * 100

  const prompt = `You are a real estate investment advisor. Analyze this property:

Purchase Price: $${data.purchasePrice.toLocaleString()}
Down Payment: ${data.downPaymentPercent}% ($${downPayment.toLocaleString()})
Estimated Rent: $${data.estimatedRent.toLocaleString()}/month
Cap Rate: ${capRate.toFixed(2)}%
Cash Flow: $${cashFlow.toLocaleString()}/year
Cash-on-Cash Return: ${cashOnCashReturn.toFixed(2)}%

Determine if this is a good investment:

{
  "verdict": "good" | "fair" | "poor",
  "rating": 7.5,
  "strengths": [
    "Positive cash flow of $500/month",
    "Cap rate above market average"
  ],
  "weaknesses": [
    "High HOA fees reduce profitability",
    "Maintenance reserve may be underestimated"
  ],
  "red_flags": [],
  "opportunities": [
    "Could increase rent by 5% based on market comps",
    "Potential for appreciation in growing neighborhood"
  ],
  "recommendation": "Solid rental property with positive cash flow. Consider negotiating purchase price down 3% to improve returns.",
  "ideal_buyer_profile": "Experienced investor comfortable with property management"
}`

  try {
    const analysis = await generateAIJSON(prompt)

    return {
      success: true,
      financial_metrics: {
        purchase_price: data.purchasePrice,
        down_payment: downPayment,
        loan_amount: loanAmount,
        monthly_mortgage: Math.round(monthlyMortgage),
        monthly_expenses: Math.round(monthlyExpenses),
        monthly_rent: data.estimatedRent,
        monthly_cash_flow: Math.round(cashFlow / 12),
        annual_cash_flow: Math.round(cashFlow),
        cap_rate: parseFloat(capRate.toFixed(2)),
        cash_on_cash_return: parseFloat(cashOnCashReturn.toFixed(2)),
        roi: parseFloat(((cashFlow / downPayment) * 100).toFixed(2)),
      },
      analysis: analysis.data,
    }
  } catch (error) {
    console.error("[v0] Error in analyzeInvestmentProperty:", error)
    return {
      success: true,
      financial_metrics: {
        purchase_price: data.purchasePrice,
        down_payment: downPayment,
        monthly_cash_flow: Math.round(cashFlow / 12),
        cap_rate: parseFloat(capRate.toFixed(2)),
        cash_on_cash_return: parseFloat(cashOnCashReturn.toFixed(2)),
      },
    }
  }
}

// ============================================
// MOVING COST ESTIMATOR
// ============================================

export async function estimateMovingCosts(data: {
  currentCity: string
  currentState: string
  newCity: string
  newState: string
  homeSize: "studio" | "1br" | "2br" | "3br" | "4br+" | "house"
  distance: number // miles
  moveDate: string
}) {
  const baseCosts = {
    studio: { movers: 800, boxes: 150, truck: 300 },
    "1br": { movers: 1200, boxes: 200, truck: 400 },
    "2br": { movers: 1800, boxes: 300, truck: 500 },
    "3br": { movers: 2500, boxes: 400, truck: 600 },
    "4br+": { movers: 3500, boxes: 500, truck: 800 },
    house: { movers: 4000, boxes: 600, truck: 1000 },
  }

  const costs = baseCosts[data.homeSize]
  const distanceMultiplier = data.distance > 100 ? 1.5 : 1.0

  const estimates = {
    professional_movers: Math.round(costs.movers * distanceMultiplier),
    packing_materials: costs.boxes,
    truck_rental: costs.truck,
    storage: 150, // per month if needed
    utilities_setup: 200,
    address_changes: 50,
    cleaning: 300,
    travel: data.distance > 50 ? 500 : 0,
    contingency: 500,
  }

  const totalCost = Object.values(estimates).reduce((a, b) => a + b, 0)

  return {
    success: true,
    cost_breakdown: estimates,
    total_estimated_cost: totalCost,
    moving_timeline: {
      "8_weeks_before": ["Research moving companies", "Declutter and donate"],
      "6_weeks_before": ["Get moving quotes", "Start packing non-essentials"],
      "4_weeks_before": ["Book movers", "Transfer utilities"],
      "2_weeks_before": ["Pack everything", "Confirm all arrangements"],
      "1_week_before": ["Final packing", "Clean current home"],
      moving_day: ["Supervise movers", "Do final walkthrough"],
    },
    downloadable_checklist_url: "/tools/moving-checklist.pdf",
  }
}

// UUID shape check — `id` below is interpolated into a PostgREST .or() filter
// string, so it must be proven to be a bare UUID first (a crafted value could
// otherwise smuggle extra filter clauses into the expression).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Get all calculator results for one person (store history).
//
// IDENTITY CLASS (lane W3 2026-09-01): `contacts.id` and `leads.id` are DISJOINT
// id spaces, and calculator_history carries BOTH columns (lead_id FKs leads,
// contact_id FKs contacts — scripts/schema-snapshot.ts:162). The only live
// caller is the portal (app/portal/[contactId]/resources/page.tsx), which holds
// a contacts.id; this used to filter lead_id only, so a contact's saved history
// could never come back. Read on BOTH columns so either identity class finds its
// own rows.
export async function getCalculatorHistory(id: string) {
  const supabase = await createClient()

  if (!UUID_RE.test(id)) {
    console.error("[v0] getCalculatorHistory: id is not a UUID — refusing the read")
    return []
  }

  const { data, error } = await supabase
    .from("calculator_history")
    .select("*")
    .or(`lead_id.eq.${id},contact_id.eq.${id}`)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) {
    console.error("[v0] Error fetching calculator history:", error)
    return []
  }

  return data || []
}

// Save calculator results for follow-up tracking.
//
// IDENTITY CLASS (lane W3 2026-09-01): callers pass EXACTLY ONE of leadId /
// contactId, and the matching column is written. This used to take only leadId
// and write only calculator_history.lead_id — which FKs leads(id) — so the
// portal (whose identity is a contacts.id) had EVERY save refused by the FK and
// surfaced "Estimate not saved" on every calculator. contact_id already exists
// on the table (scripts/schema-snapshot.ts:162); a contacts.id belongs there,
// never in the leads FK.
export async function saveCalculatorResult(data: {
  /** leads.id — for lead-side callers only. Mutually exclusive with contactId. */
  leadId?: string
  /** contacts.id — the portal's identity class. Mutually exclusive with leadId. */
  contactId?: string
  calculatorType: "seller_net" | "mortgage_comparison" | "neighborhood_compare" | "investment_analyzer" | "moving_cost"
  inputs: any
  results: any
}) {
  const supabase = await createClient()

  // Exactly one identity — a row with both would misattribute, a row with
  // neither is unreadable by anyone. Refuse rather than guess (§4 fail closed).
  if ((data.leadId ? 1 : 0) + (data.contactId ? 1 : 0) !== 1) {
    console.error("[v0] saveCalculatorResult: exactly one of leadId/contactId is required")
    return { success: false }
  }

  const { error } = await supabase.from("calculator_history").insert({
    lead_id: data.leadId ?? null,
    contact_id: data.contactId ?? null,
    calculator_type: data.calculatorType,
    inputs: data.inputs,
    results: data.results,
  })

  if (error) {
    console.error("[v0] Error saving calculator result:", error)
    return { success: false }
  }

  return { success: true }
}

// ============================================
// PUBLIC TOOLS (Zero Friction, No Email Required)
// ============================================

/**
 * Track tool usage anonymously.
 *
 * This is the anon write the m394 carve-out exists for: `tool_usage_sessions`
 * INSERT is `WITH CHECK (TRUE)` to role PUBLIC (verified live), so an anonymous
 * caller can write it and that is intended. It is bounded here in three ways —
 * per-IP volume, payload size, and column-shaped clamps on the caller-supplied
 * text and integer.
 *
 * NEVER THROWS AND NEVER CHANGES THE CALLER'S RESULT. Every caller awaits this
 * mid-computation and returns its own calculation afterwards, so a rejected or
 * refused tracking write must not affect what the visitor sees. That is the
 * degradation the owner asked for: reject the write, still return the result.
 *
 * The `try/catch` this used to carry CAUGHT NOTHING: supabase-js RESOLVES a
 * refused insert rather than rejecting, so a 23502/42501 arrived as a fulfilled
 * promise and the handler never ran. `error` is destructured now.
 *
 * ── TENANT VERDICT: DECIDE FOR THE ANONYMOUS LANE, STAMP FOR THE REST ────────
 * This writer is reached from BOTH sides, which is why it is neither a flat
 * "always NULL" nor a flat "always stamp":
 *
 *   · A genuinely logged-out visitor on the public calculators has NO tenant.
 *     NULL is the correct value for them, and forcing one on would be inventing
 *     an attribution. The m394 `keep_anon_insert` carve-out (carried by m396,
 *     asserted by m395/m397) exists precisely so that lane keeps working, and
 *     nothing here narrows it — `tool_usage_sessions_insert` is still
 *     `WITH CHECK (true)` to PUBLIC (verified live).
 *   · But `calculateRentVsBuy` is called from /dashboard/calculators and
 *     /dashboard/ai-tools — signed-in screens — and `calculateHomeValue` has
 *     ALREADY resolved a brokerage before it gets here (session, or
 *     `agents.public_slug` for a public visitor). Those rows have a real tenant
 *     and were being filed without it.
 *
 * WHY THAT MATTERED, both ways round. `tool_usage_sessions_select` is
 * `is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)`
 * granted to `authenticated`, so an unstamped row is not hidden — it is readable
 * by every signed-in user of every other brokerage. And in the other direction,
 * the one reader that exists (app/actions/analytics.ts aggregateValueDelivered)
 * filters `.eq("brokerage_id", brokerageId)`; `NULL = <uuid>` is NULL, never
 * true, so that metric has been counting ZERO tool sessions for every brokerage
 * since the column was added. Stamping the attributable rows is what makes it
 * count anything. Anonymous rows stay uncounted, which is honest — they cannot
 * be attributed to a brokerage.
 *
 * `brokerageId` is only ever passed here already-RESOLVED by the caller (from a
 * session or from a public slug). It is never taken from a caller-supplied
 * parameter — `calculateRentVsBuy` accepts a `brokerageId` argument for its
 * commission lookup and that value is deliberately NOT used for this stamp.
 */
async function trackToolUsage(data: {
  tool: string
  visitorId: string
  inputs: any
  location?: string
  timeSpent?: number
  /** Session- or slug-resolved tenant. NULL for a genuinely anonymous visitor. */
  brokerageId?: string | null
}) {
  const verdict = await publicCalcRateVerdict("toolUsage")
  if (!verdict.allowed) {
    // Over the per-IP window: the analytics row is dropped, the calculation the
    // caller asked for is unaffected. Not an error the visitor ever sees.
    console.warn(
      `[calculators.trackToolUsage] rate limited (tool=${data.tool}); analytics row dropped, result still returned`,
    )
    return
  }

  const supabase = await createClient()

  // time_spent_seconds is a NOT NULL int4 fed straight from the client. Clamped
  // to a real day so a caller cannot overflow the column (which supabase-js would
  // hand back as a resolved "success") or file a nonsense negative duration.
  const timeSpent = Number.isFinite(data.timeSpent)
    ? Math.min(Math.max(Math.trunc(data.timeSpent as number), 0), 86_400)
    : 0

  const { error } = await supabase.from("tool_usage_sessions").insert({
    tool_name: boundPublicText(data.tool) ?? "unknown",
    visitor_id: boundPublicText(data.visitorId),
    // Tenant when one was resolved, NULL for the anonymous lane. See the verdict
    // in the doc comment above — this is the one column that must NOT be forced.
    brokerage_id: data.brokerageId ?? null,
    session_data_json: boundPersistedPayload({
      inputs: data.inputs,
      location: boundPublicText(data.location),
    }),
    time_spent_seconds: timeSpent,
    // TOMBSTONE (§6, one vocabulary): `timestamp` DELETED from this insert.
    // SURVIVOR: `created_at` (same table, DEFAULT NOW()) — the column every
    // reader already filters on (app/actions/analytics.ts:85,
    // lib/finance/usage-metering.ts:31). `timestamp` was a second spelling of
    // the same instant (also NOT NULL DEFAULT NOW(), scripts/…059 DDL) that no
    // code ever read; writing both invited the two to disagree. m580 drops the
    // column and re-points its index at created_at (WRITTEN, NOT APPLIED).
  })

  if (error) {
    // Recorded, never rethrown — analytics must not break a public calculator.
    console.error("[calculators.trackToolUsage] tracking insert refused:", error.message)
  }
}

/**
 * The caller's brokerage, from the SESSION, or null when there is no session.
 *
 * The one legitimate way for a public-surface action in this file to learn a
 * tenant: `getAgentContext()` reads `supabase.auth.getUser()` and never throws,
 * returning an unauthenticated context instead. Dynamic import to match
 * `calculateHomeValue` below, which already resolves its brokerage this way.
 *
 * NULL here is a real answer ("this visitor is anonymous"), not a failed lookup —
 * which is exactly why it is safe to write it to `tool_usage_sessions`, a table
 * with a deliberate anon carve-out, and NOT to `saved_calculations`, which has
 * none.
 *
 * ONE DIVERGENCE WORTH KNOWING, since a stamp taken from here is later matched by
 * RLS: `current_user_brokerage_id()` is `SELECT brokerage_id FROM users WHERE
 * id = auth.uid()`, whereas getAgentContext() falls back to
 * `user_role_assignments.brokerage_id` and then to auth metadata when
 * `users.brokerage_id` is null. For every normal user the two agree (the dashboard
 * page that reaches these actions reads `users.brokerage_id` itself). For a user
 * carrying a brokerage ONLY on a role assignment they would diverge, and that user
 * could not read back their own saved row. Not papered over with a NULL stamp —
 * that would publish the row to the whole platform, which is strictly worse.
 * Reconciling the two resolvers is a change to lib/identity, not to this file.
 */
async function sessionBrokerageIdOrNull(): Promise<string | null> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const session = await getAgentContext()
  return session.isAuthenticated && session.brokerageId ? session.brokerageId : null
}

// Generate an anonymous visitor ID.
//
// This id is not decoration: `saved_calculations` rows are filed under it and
// `getSavedCalculations` reads them BACK by it, so it is the only credential
// standing between an anonymous caller and someone else's saved calculation
// (including the email address they saved it with). It was
// `visitor_${Date.now()}_${Math.random().toString(36).substring(7)}` —
// a guessable millisecond timestamp plus ~5-6 base-36 characters. That is the
// same too-weak-to-be-a-bearer-credential shape the calculator share token was
// removed for. Now a v4 uuid, matching lib/tools/visitor-id.ts, which is what the
// browser side already mints.
function generateVisitorId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // Node 18 without the global; never the timestamp shape.
  return `visitor-${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("")}`
}

// ============================================
// HOME VALUE CALCULATOR (Public, No Gate)
// ============================================

/**
 * Public home-value estimate, grounded in the real CMA engine.
 *
 * The comps used to come from IDX `getProperties({ status:"sold", address,
 * proximity:true })` — a call that could not work: none of those filters were
 * read, and IDX cannot serve sold comparables from a bare API key at all. The
 * prompt then rendered every "comp" as `Sold $undefined` and asked a chat model
 * to produce an estimated_value, a price per sqft, a rental estimate and a list
 * of renovation ROIs from that. All of it was invented.
 *
 * Comps now come from lib/cma/ai-cma-orchestrator.runAiCma — grounded comp
 * sourcing with citations, state appraiser-guideline adjustments applied per comp,
 * and a value range derived from the ADJUSTED prices. Same engine the seller
 * home-value lane uses (app/actions/home-value.ts generateAIValuation), so the
 * product has one valuation method rather than two.
 *
 * runAiCma is brokerage-scoped and its adjustment rates are state-specific, so
 * a brokerage and a `state` are required inputs. `state` is not derivable from an
 * address string and is not substituted from any other id space — the caller must
 * supply it.
 *
 * 🚨 THE BROKERAGE IS NO LONGER THE CALLER'S TO NAME.
 * This is a `"use server"` export, i.e. a public HTTP endpoint, and it is
 * deliberately unauthenticated (a lead-magnet calculator that demanded a login
 * would not be one). It used to take `brokerageId` as a raw uuid parameter and
 * hand it to `runAiCma`, which calls `sourceCompsForCma` — PAID comparable-sales
 * providers — and then an LLM for the narrative. So any anonymous caller could
 * run unlimited paid comp lookups and model calls **attributed to any brokerage
 * whose uuid they had**. The brokerage is now RESOLVED, never asserted:
 *
 *   1. from the session when the caller is signed in (the dashboard calculators);
 *   2. otherwise from `agentSlug` — `agents.public_slug`, the same public handle
 *      /home-value/[agentSlug] already personalises itself from. A public handle
 *      is a thing the visitor legitimately holds; a tenant uuid is not.
 *   3. neither → refused.
 *
 * ✅ RESOLVED (owner ruling: rate-limit, keep it open). This lane is now bounded
 * per-IP through `lib/security/public-rate-limit.ts`, the limiter that already
 * fronts signup and the embed widget — the note that used to sit here ("there is
 * no rate-limit helper in this repo to reach for") was written before that module
 * existed and was stale.
 *
 * The check runs BEFORE the paid work, which is the only placement that bounds
 * anything: `runAiCma` calls paid comparable-sales providers and then an LLM, so
 * a limiter consulted after the fact would rate-limit only the response. That is
 * also why this one surface REFUSES on the limit instead of degrading like the
 * analytics write does — there is no already-computed result to hand back, and
 * the thing being protected is a brokerage's provider spend.
 *
 * 🚩 STILL OPEN: the sibling public lane `submitHomeValueRequest`
 * (app/actions/home-value.ts) has the same exposure and is NOT in this file's
 * scope. It should take the same treatment.
 */
export async function calculateHomeValue(
  address: string,
  opts: {
    /**
     * The agent's `public_slug`. Required on public surfaces; ignored when the
     * caller is authenticated (the session's brokerage wins).
     */
    agentSlug?: string
    /** Required — 2-letter. runAiCma's adjustment rates are per state. */
    state: string
    city?: string | null
    zipCode?: string | null
    /** Subject facts, when the caller collected them. Unknown stays null. */
    bedrooms?: number | null
    bathrooms?: number | null
    squareFeet?: number | null
    yearBuilt?: number | null
    propertyType?: "single_family" | "condo" | "townhouse" | null
    visitorId?: string
  },
) {
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const { BatchDataClient } = await import("@/lib/batchdata-client")
  const { runAiCma } = await import("@/lib/cma/ai-cma-orchestrator")

  const vid = opts.visitorId || generateVisitorId()

  // ── BOUND THE SPEND BEFORE INCURRING IT ────────────────────────────────────
  // Ahead of the provider clients and ahead of runAiCma, because everything below
  // this line costs the resolved brokerage real money per call.
  const rateVerdict = await publicCalcRateVerdict("homeValue")
  if (!rateVerdict.allowed) {
    return {
      success: false,
      error: `Too many valuation requests from this connection. Please try again in ${rateVerdict.retryAfterSeconds} seconds.`,
      visitorId: vid,
    }
  }

  const batchData = new BatchDataClient()

  // ── Resolve the brokerage this CMA (and its paid provider spend) runs under ──
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const session = await getAgentContext()
  let brokerageId: string | null =
    session.isAuthenticated && session.brokerageId ? session.brokerageId : null

  if (!brokerageId && opts.agentSlug?.trim()) {
    const { getAgentBySlug } = await import("@/app/actions/home-value")
    const agent = await getAgentBySlug(opts.agentSlug.trim())
    // getAgentBySlug returns null both for "no such slug" and for a refused read
    // — either way there is no brokerage, and this must fail closed rather than
    // proceed against a guessed one.
    brokerageId = agent?.brokerage_id ?? null
  }

  if (!brokerageId) {
    return {
      success: false,
      error: "This calculator must be opened from an agent's page.",
      visitorId: vid,
    }
  }

  // The IDX client is built from the brokerage RESOLVED just above — the same one
  // runAiCma's paid comp sourcing is billed to — and not a second time from
  // something else. It used to be `new IDXBrokerClient()`, so the agent whose
  // public page this calculator is embedded on had their own connected IDX Broker
  // account ignored in favour of the platform's, on a surface that is explicitly
  // presented as theirs. Constructed only AFTER the refusal above, so an
  // unresolvable brokerage never reaches a credential at all.
  //
  // The agent tier is passed only for a signed-in caller: `agentUserId` is a
  // USERS.id, and the public path resolved a brokerage from `agents.public_slug` —
  // an AGENTS-class row. Those are disjoint spaces, so nothing from the slug lookup
  // is substituted here; the public visitor simply resolves at brokerage tier.
  const idxClient = await IDXBrokerClient.forBrokerage(brokerageId, {
    agentUserId: session.isAuthenticated && session.userId ? session.userId : null,
    // Team tier, on the same rule as the agent tier above: only a signed-in
    // caller has one. The public slug path resolves an AGENTS-class row and
    // carries no team, so it resolves at brokerage tier rather than borrowing
    // a team it cannot prove.
    teamId: session.isAuthenticated ? session.teamId : null,
  })

  try {
    const [property, propertyData, cma] = await Promise.all([
      idxClient.searchProperties(address),
      batchData.searchByAddress(address, opts.city ?? "", opts.state),
      runAiCma({
        mode: "standard",
        brokerageId,
        subject: {
          address,
          city: opts.city ?? null,
          state: opts.state,
          zip: opts.zipCode ?? null,
          propertyType: opts.propertyType ?? null,
          sqftLiving: opts.squareFeet ?? null,
          bedrooms: opts.bedrooms ?? null,
          // Callers supply one bathroom count, not a full/half split.
          fullBaths: opts.bathrooms ?? null,
          halfBaths: null,
          yearBuilt: opts.yearBuilt ?? null,
        },
      }),
    ])

    // Track usage regardless of whether comps were found. The tenant is the one
    // RESOLVED above (session, else `agents.public_slug`) — the same brokerage
    // this call's paid comp sourcing is billed to. Never a caller-named uuid.
    await trackToolUsage({
      tool: "home_value",
      visitorId: vid,
      inputs: { address, city: opts.city ?? null, state: opts.state, zipCode: opts.zipCode ?? null },
      location: opts.city ?? undefined,
      brokerageId,
    })

    // No comp survived → there is no value to show. Say that; do not fall back to
    // a number no sale supports.
    if (cma.estimatedValueMid <= 0 || cma.adjustedComps.length === 0) {
      return {
        success: false,
        error:
          "We could not find enough recent comparable sales near this address to produce a value estimate. A local agent can walk the property and give you a figure grounded in real recent sales.",
        visitorId: vid,
      }
    }

    const comparables = cma.adjustedComps.map((a) => {
      const sqft = a.comp.sqftLiving ?? null
      return {
        address: a.comp.address,
        sale_price: Math.round(a.comp.salePrice),
        sale_date: a.comp.saleDate,
        beds: a.comp.bedrooms ?? null,
        baths: (a.comp.fullBaths ?? 0) + (a.comp.halfBaths ?? 0) * 0.5 || null,
        sqft,
        price_per_sqft:
          a.comp.pricePerSqft != null
            ? Math.round(a.comp.pricePerSqft)
            : sqft && sqft > 0
              ? Math.round(a.comp.salePrice / sqft)
              : null,
        adjusted_price: Math.round(a.adjustedPrice),
        total_adjustment: Math.round(a.totalAdjustment),
        // Real per-comp distance when the provider published one (RentCast
        // does); null when it did not — unknown, not zero.
        distance_miles: a.comp.distanceMiles ?? null,
        citation: a.comp.citation ?? null,
      }
    })

    return {
      success: true,
      property: property?.[0],
      propertyIntelligence: propertyData?.[0],
      valuation: {
        estimated_value: Math.round(cma.estimatedValueMid),
        value_range: { low: Math.round(cma.estimatedValueLow), high: Math.round(cma.estimatedValueHigh) },
        // runAiCma reports 0..1; expose it as 0-100 like the seller lane does.
        confidence_score: Math.round(cma.confidenceScore * 100),
        methodology: "ai_cma",
        narrative: cma.aiNarrative,
        citations: cma.citations,
        state_guidelines_used: cma.stateGuidelinesUsed,
        // WHICH YEAR'S guidelines priced it, and whether that is this CMA's own
        // year — carried so a caller cannot read the rates as current by default.
        state_guideline_vintage: cma.stateGuidelineVintage,
        generated_at: cma.generatedAt,
      },
      comparables,
      // Everything the previous version asserted and could not know — rental
      // income, renovation ROIs, days-on-market prediction, neighborhood trend —
      // is absent rather than invented.
      unavailable: [
        "rental_income_estimate",
        "days_on_market_prediction",
        "value_boosting_improvements",
        "neighborhood_trends",
      ],
      disclaimers: cma.disclaimers,
      visitorId: vid,
      disclaimer:
        "This is an estimated market value based on adjusted comparable sales. Not an official appraisal.",
    }
  } catch (error) {
    console.error("[v0] Home value calculation error:", error)
    return {
      success: false,
      error: "Unable to calculate home value. Please verify the address and try again.",
    }
  }
}

// ============================================
// AFFORDABILITY CALCULATOR (Public, No Gate)
// ============================================

export async function calculateAffordability(data: {
  annualIncome: number
  monthlyDebts: number
  downPayment: number
  interestRate: number
  propertyTaxRate?: number
  hoaFees?: number
  visitorId?: string
}) {
  const vid = data.visitorId || generateVisitorId()

  const propertyTaxRate = data.propertyTaxRate || 0.0125 // 1.25% default
  const hoaFees = data.hoaFees || 0

  // Calculate debt-to-income ratios
  const maxMonthlyPayment = (data.annualIncome / 12) * 0.28 // 28% front-end DTI
  const maxWithDebts = (data.annualIncome / 12) * 0.36 - data.monthlyDebts // 36% back-end DTI

  const affordableMonthly = Math.min(maxMonthlyPayment, maxWithDebts)

  // Calculate max home price
  const monthlyRate = data.interestRate / 100 / 12
  const numPayments = 30 * 12

  const pniFactor = (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1)

  // Working backwards: affordableMonthly = P&I + property tax + insurance + HOA
  const insuranceEstimate = 150 // Average monthly homeowners insurance
  const availableForPI = affordableMonthly - hoaFees - insuranceEstimate

  // Iterative calculation for max home price
  let maxHomePrice = 0
  for (let price = 100000; price <= 10000000; price += 1000) {
    const loanAmount = price - data.downPayment
    const pi = loanAmount * pniFactor
    const propertyTax = (price * propertyTaxRate) / 12
    const pmi = loanAmount > price * 0.8 ? loanAmount * 0.005 : 0

    if (pi + propertyTax + pmi <= availableForPI) {
      maxHomePrice = price
    } else {
      break
    }
  }

  const loanAmount = maxHomePrice - data.downPayment
  const monthlyPI = loanAmount * pniFactor
  const monthlyPropertyTax = (maxHomePrice * propertyTaxRate) / 12
  const monthlyInsurance = insuranceEstimate
  const monthlyPMI = loanAmount > maxHomePrice * 0.8 ? (loanAmount * 0.005) / 12 : 0

  const totalMonthlyPayment = monthlyPI + monthlyPropertyTax + monthlyInsurance + monthlyPMI + hoaFees

  // Track usage. Tenant from the SESSION only — this action takes no brokerage
  // argument and must not acquire one, so a logged-out visitor files an
  // untenanted (anonymous) row and a signed-in caller files an attributable one.
  await trackToolUsage({
    tool: "affordability",
    visitorId: vid,
    inputs: data,
    brokerageId: await sessionBrokerageIdOrNull(),
  })

  return {
    success: true,
    maxHomePrice,
    downPayment: data.downPayment,
    loanAmount,
    monthlyBreakdown: {
      principal_interest: Math.round(monthlyPI),
      property_tax: Math.round(monthlyPropertyTax),
      insurance: Math.round(monthlyInsurance),
      pmi: Math.round(monthlyPMI),
      hoa: hoaFees,
      total: Math.round(totalMonthlyPayment),
    },
    hiddenCosts: {
      closing_costs: Math.round(maxHomePrice * 0.025), // Approximate buyer closing costs (non-commission)
      maintenance_budget: Math.round(maxHomePrice * 0.01) / 12,
      utilities_estimate: 250,
    },
    recommendations: [
      data.downPayment < maxHomePrice * 0.2
        ? "Increase down payment to 20% to avoid PMI and save $" + Math.round(monthlyPMI) + "/month"
        : "Great down payment! No PMI required.",
      data.monthlyDebts > data.annualIncome / 12 * 0.2 ? "Consider reducing monthly debts to increase buying power" : "Debt levels look healthy",
      "Budget $" + Math.round((maxHomePrice * 0.01) / 12) + "/month for home maintenance",
    ],
    visitorId: vid,
  }
}

// ============================================
// RENT VS BUY CALCULATOR (Public, No Gate)
// ============================================

export async function calculateRentVsBuy(data: {
  rentAmount: number
  homePrice: number
  downPayment: number
  interestRate: number
  yearsToStay: number
  annualAppreciation?: number
  city?: string
  visitorId?: string
  brokerageId: string
}) {
  const vid = data.visitorId || generateVisitorId()

  // Get brokerage commission structure for selling scenario
  const commissionStructure = await getDefaultCommissionStructure(data.brokerageId)
  const totalCommissionRate = (commissionStructure.agentBuyerSideRate + commissionStructure.brokerageBuyerSideRate) + (commissionStructure.agentListingSideRate + commissionStructure.brokerageListingSideRate)

  const appreciationRate = data.annualAppreciation || 0.03 // 3% default (market appreciation, not brokerage config)
  const propertyTaxRate = 0.0125
  const maintenanceRate = 0.01

  // Buying costs
  const loanAmount = data.homePrice - data.downPayment
  const monthlyRate = data.interestRate / 100 / 12
  const numPayments = 30 * 12
  const monthlyPI = loanAmount * ((monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1))

  const monthlyPropertyTax = (data.homePrice * propertyTaxRate) / 12
  const monthlyInsurance = 150
  const monthlyMaintenance = (data.homePrice * maintenanceRate) / 12

  const totalMonthlyOwnership = monthlyPI + monthlyPropertyTax + monthlyInsurance + monthlyMaintenance

  // Calculate over time period
  let totalRentCost = 0
  let totalOwnershipCost = data.downPayment + data.homePrice * 0.025 // Down payment + buyer closing costs (non-commission)
  let homeValueAfterYears = data.homePrice

  for (let year = 1; year <= data.yearsToStay; year++) {
    // Rent increases 3% annually
    const yearlyRent = data.rentAmount * 12 * Math.pow(1.03, year - 1)
    totalRentCost += yearlyRent

    // Ownership costs
    totalOwnershipCost += totalMonthlyOwnership * 12

    // Home appreciates
    homeValueAfterYears = data.homePrice * Math.pow(1 + appreciationRate, year)
  }

  // Calculate equity and ROI for buying
  const equityBuilt = homeValueAfterYears - loanAmount
  const netProceedsAfterSelling = homeValueAfterYears - loanAmount - homeValueAfterYears * totalCommissionRate // After commission

  const breakEvenPoint = Math.ceil(
    (data.downPayment + data.homePrice * 0.025) / ((totalMonthlyOwnership - data.rentAmount) * 12 + data.homePrice * appreciationRate),
  )

  // Track usage. NOT `data.brokerageId` — that parameter is the caller's to name
  // (this is a `"use server"` export), and stamping from it would let any caller
  // choose which tenant's analytics they land in. The commission lookup above can
  // live with a caller-supplied id because it only READS a config; a tenant stamp
  // cannot. Resolved from the session instead, NULL when there is none.
  await trackToolUsage({
    tool: "rent_vs_buy",
    visitorId: vid,
    inputs: data,
    location: data.city,
    brokerageId: await sessionBrokerageIdOrNull(),
  })

  const recommendation =
    breakEvenPoint <= data.yearsToStay
      ? `BUYING is better if you stay ${data.yearsToStay} years. You'll build $${Math.round(equityBuilt).toLocaleString()} in equity.`
      : `RENTING is better for ${data.yearsToStay} years. You'd need to stay ${breakEvenPoint} years to break even on buying.`

  return {
    success: true,
    recommendation,
    breakEvenYears: breakEvenPoint,
    rentScenario: {
      totalCost: Math.round(totalRentCost),
      monthlyPayment: data.rentAmount,
      equityBuilt: 0,
    },
    buyScenario: {
      totalCost: Math.round(totalOwnershipCost),
      monthlyPayment: Math.round(totalMonthlyOwnership),
      equityBuilt: Math.round(equityBuilt),
      homeValueAfterYears: Math.round(homeValueAfterYears),
      netProceedsIfSold: Math.round(netProceedsAfterSelling),
    },
    analysis: {
      opportunityCost: `If you invested the down payment instead, it could grow to $${Math.round(data.downPayment * Math.pow(1.07, data.yearsToStay)).toLocaleString()} at 7% annual return`,
      taxBenefits: `Estimated $${Math.round((monthlyPI * 0.25) / 12)} monthly tax deduction (25% tax bracket)`,
      flexibilityFactor: data.yearsToStay < 3 ? "Renting provides more flexibility for short-term plans" : "Buying builds wealth for longer stays",
    },
    visitorId: vid,
  }
}

// ============================================
// SAVE & SHARE FUNCTIONALITY
// ============================================

/**
 * Persist a calculation under a visitor id.
 *
 * Covered by the same abuse ruling as `trackToolUsage` — per-IP volume plus a
 * payload cap, degrading OPEN if the limiter is unavailable.
 *
 * ── THE LANE IS NOT LOGGED-OUT. THE COMMENT SAID IT WAS. ─────────────────────
 * This was documented as the "second logged-out write path on this surface".
 * Measured, not assumed: the ONLY caller of saveCalculation is
 * app/dashboard/calculators/calculators-client.tsx (three call sites), and
 * app/dashboard/calculators/page.tsx `redirect("/login")`s an unauthenticated
 * visitor before that client ever mounts. So every real save already comes from
 * a signed-in dashboard user — which is exactly what the live policy says too:
 * `saved_calculations_insert` is granted to `authenticated` only, so a genuinely
 * logged-out save was being refused by RLS and returning `success: false`. The
 * wiring and the policy agree; only the comment disagreed with both.
 *
 * ── TENANT VERDICT: STAMP ────────────────────────────────────────────────────
 * A session is therefore always available, so a tenant always is. It is resolved
 * from the SESSION (`getAgentContext()`), never from anything the caller sends —
 * this is a `"use server"` export and every argument is the caller's to choose.
 *
 * ── WHAT LEAVING IT NULL ACTUALLY DID (the correction this pass exists for) ──
 * The earlier note said the sibling comments describing these rows as
 * "anon-readable" were wrong, and it was right — every SELECT policy on
 * `saved_calculations` is granted to `authenticated`, and role `anon` matches no
 * SELECT policy at all. Verified live again today.
 *
 * But the true statement is NOT "so there is no exposure". `saved_calculations_select`
 * is `is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)`,
 * and this function never stamped `brokerage_id` — so EVERY row in the table was
 * readable by EVERY SIGNED-IN USER OF EVERY OTHER BROKERAGE through that middle
 * clause. The rows carry `user_email` and `user_name`. That is real PII crossing
 * a real tenant boundary; it is only the ANONYMOUS half of the old claim that was
 * overstated. Stamping closes it: `has_brokerage_access(brokerage_id)` then
 * admits only the saver's own brokerage.
 *
 * The mitigations downstream (the blank-visitorId refusal and the enumerated
 * columns in `getSavedCalculations`, the visitor-id binding and on-record
 * destination in `emailCalculationResults`) are UNCHANGED and still necessary —
 * the visitor id is still the retrieval credential, and a colleague inside the
 * same brokerage is still not the person who saved the row.
 */
export async function saveCalculation(data: {
  toolName: string
  calculationData: any
  visitorId: string
  email?: string
  name?: string
}) {
  const verdict = await publicCalcRateVerdict("saveCalculation")
  if (!verdict.allowed) {
    return {
      success: false,
      error: `Too many saves from this connection. Please try again in ${verdict.retryAfterSeconds} seconds.`,
    }
  }

  // Tenant BEFORE the write. Refused rather than filed untenanted: an unstamped
  // row here is not a hidden row, it is one published to every other brokerage
  // (see the verdict above), and this table has no anon carve-out to preserve —
  // its INSERT policy is `authenticated`-only, so a session-less caller was
  // already being refused by RLS. This just refuses it honestly and in words.
  const brokerageId = await sessionBrokerageIdOrNull()
  if (!brokerageId) {
    return {
      success: false,
      error: "Sign in to save a calculation — saved calculations belong to your brokerage.",
    }
  }

  const supabase = await createClient()

  try {
    const { data: saved, error } = await supabase
      .from("saved_calculations")
      .insert({
        // Caller-supplied text into unbounded `text` columns, and a caller-supplied
        // blob into jsonb. All three are bounded for the same reason the tracking
        // row is: on a public lane the caller otherwise decides the row size.
        tool_name: boundPublicText(data.toolName) ?? "unknown",
        visitor_id: boundPublicText(data.visitorId),
        brokerage_id: brokerageId,
        calculation_data_json: boundPersistedPayload(data.calculationData),
        user_email: boundPublicText(data.email),
        user_name: boundPublicText(data.name),
      })
      .select()
      .single()

    if (error) {
      console.error("[v0] Error saving calculation:", error)
      return { success: false, error: "Failed to save calculation" }
    }

    return {
      success: true,
      savedId: saved.id,
      message: data.email
        ? "Calculation saved! We'll email you a copy for your records."
        : "Calculation saved! Use your visitor ID to retrieve it later.",
    }
  } catch (error) {
    console.error("[v0] Error in saveCalculation:", error)
    return { success: false, error: "Failed to save calculation" }
  }
}

// shareCalculation and getSharedCalculation were REMOVED here.
//
// Owner ruling: "not sure why we would need to share a calculator, sharing
// property listings yes". Listing sharing already exists at
// /dashboard/listings/[id]/share — that is the capability that was wanted.
//
// This is a capability REMOVAL on an explicit owner decision, not an orphan
// swept up for the census count. Nothing was lost, because the feature never
// worked and could not have been made to work safely as built:
//   · shareCalculation minted /tools/shared/{token}. That route DOES NOT EXIST.
//     Every link an agent copied and sent to a client 404'd.
//   · getSharedCalculation read through the SESSION client, and tool_shares RLS
//     requires has_brokerage_access(). The recipient of a share link is a client
//     — by definition not a brokerage member — so the reader could never have
//     returned the row it was written to fetch.
//   · the token was `share_${Date.now()}_${Math.random().toString(36).substring(7)}`
//     — roughly 24 bits of entropy over a guessable timestamp — and the payload
//     it fronted carried the saver's email address. Too weak to be a bearer
//     credential for a public page.
//
// Saving a calculation is UNAFFECTED and still works (saveCalculation +
// getSavedCalculations, keyed by the persisted visitor id in lib/tools/visitor-id).


/**
 * Retrieve the calculations saved under a visitor id.
 *
 * ORPHAN — no caller yet. Not a duplicate: it is the read half of
 * `saveCalculation`, and nothing else reads `saved_calculations`. The reason it
 * has no caller is recorded in lib/tools/visitor-id.ts — the calculators screen
 * used to mint a throwaway id per component, so there was never an id to call
 * this with. That half is fixed (`getOrCreateVisitorId()` persists one id per
 * browser); the missing piece is now purely UI. See the handoff in
 * docs/orphan-burndown-w2s2.md.
 *
 * The visitor id IS the retrieval credential, and RLS is not a substitute for it.
 * CORRECTED (this comment previously said these rows were "anon-readable", which
 * was wrong in one direction and complacent in the other): the live SELECT policy
 * on saved_calculations is
 * `is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)`
 * granted to `authenticated` — role `anon` matches NO select policy on this table,
 * so an anonymous caller reads nothing. What the `brokerage_id IS NULL` clause did
 * instead was PUBLISH every unstamped row to every signed-in user of every OTHER
 * brokerage, because saveCalculation never stamped. It stamps now, so this read is
 * scoped by `has_brokerage_access` to the saver's own brokerage — but a colleague
 * inside that brokerage is still not the person who saved the row, which is why
 * both mitigations below stay exactly as they are:
 *   · an empty/blank id is refused outright, so this can never degrade into
 *     `.eq("visitor_id", "")` matching rows saved with a missing id;
 *   · the columns are enumerated instead of `select("*")`. user_email and
 *     user_name are deliberately NOT returned — a retrieval panel does not need
 *     them, and returning them turned a guessed visitor id into a PII disclosure
 *     rather than just a calculation disclosure.
 */
export async function getSavedCalculations(visitorId: string) {
  const supabase = await createClient()

  if (!visitorId?.trim()) {
    return { success: false, calculations: [] }
  }

  try {
    const { data, error } = await supabase
      .from("saved_calculations")
      .select("id, tool_name, calculation_data_json, created_at")
      .eq("visitor_id", visitorId.trim())
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) {
      console.error("[v0] Error fetching saved calculations:", error)
      return { success: false, calculations: [] }
    }

    return {
      success: true,
      calculations: data || [],
    }
  } catch (error) {
    console.error("[v0] Error in getSavedCalculations:", error)
    return { success: false, calculations: [] }
  }
}


/**
 * Email a saved calculation back to the visitor who saved it.
 *
 * THIS IS A PUBLIC LANE AND IT USED TO BE AN OPEN EMAIL RELAY. It is exported
 * from a `"use server"` module, so it is a reachable HTTP endpoint, and it had
 * NO authentication of any kind. It read `saved_calculations` by a
 * caller-supplied `calculationId` and then sent that row's contents to a
 * caller-supplied `recipientEmail`. Two consequences, both live:
 *
 *   1. OPEN RELAY. Any anonymous caller could send mail from the platform's
 *      sending domain to any address they chose, with attacker-influenced
 *      content (the calculation body). That is a deliverability/reputation
 *      incident waiting to happen, not a theoretical one.
 *   2. PII EXFILTRATION. The row carries user_email and user_name, and RLS did
 *      NOT stop this read. CORRECTED — this said "anon-readable", which is not
 *      what the policy does. The live SELECT policy is
 *      `is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)`
 *      granted to `authenticated`; role `anon` matches no SELECT policy on this
 *      table at all. But saveCalculation() above never set brokerage_id, so that
 *      middle clause made EVERY row readable by EVERY SIGNED-IN USER OF EVERY
 *      OTHER BROKERAGE — cross-tenant PII, not anonymous PII. Re-verified against
 *      the live policy, not assumed. saveCalculation() stamps now, so rows are
 *      scoped to the saving brokerage. No backfill was needed: the table held
 *      zero rows when the stamp went in (counted live, not presumed).
 *
 * The fix binds both ends to something the caller must already hold. It leaves
 * the ENDPOINT unauthenticated — it is still a reachable `"use server"` export
 * with no login gate, which is what "public" meant here — but note that since
 * saveCalculation() now stamps `brokerage_id`, the row read below is reachable
 * only by the saving brokerage, so in practice an anonymous caller gets nothing
 * from this action either. The two bindings are what make that safe rather than
 * incidental:
 *
 *   · The row is fetched scoped by `visitorId`, the same opaque per-visitor
 *     secret getSavedCalculations() already treats as the retrieval key. You
 *     cannot act on a calculation whose visitor id you do not have.
 *   · The destination is NOT the caller's to choose. It is the address recorded
 *     ON THE ROW at save time. A supplied recipientEmail is accepted only when
 *     it matches that address, so the parameter can stay for call-site clarity
 *     without being an injection point.
 *
 * A row saved without an email address cannot be mailed at all, and says so.
 */
export async function emailCalculationResults(data: {
  calculationId: string
  /** The visitor secret the calculation was saved under — required, and the
   *  only thing standing between this endpoint and the whole table. */
  visitorId: string
  /** Optional. When present it must equal the address recorded on the row;
   *  it can never redirect the send. */
  recipientEmail?: string
  recipientName?: string
}) {
  // THIRD LOGGED-OUT PATH ON THIS SURFACE. It is not a database write, it is an
  // OUTBOUND SEND, which is why it carries the tightest window of the four: the
  // visitor-id binding above already stops an attacker choosing the destination,
  // but nothing stopped them re-sending the same legitimate message in a loop and
  // burning the platform's sending reputation on it.
  const verdict = await publicCalcRateVerdict("emailResults")
  if (!verdict.allowed) {
    return {
      success: false,
      error: `Too many email requests from this connection. Please try again in ${verdict.retryAfterSeconds} seconds.`,
    }
  }

  const supabase = await createClient()

  try {
    if (!data.visitorId?.trim()) {
      return { success: false, error: "Calculation not found" }
    }

    // Destructure the error. supabase-js RESOLVES a refused query, so
    // `const { data }` alone turns a refusal into an indistinguishable
    // "no rows" — and this path decides whether to send mail.
    const { data: calculation, error: readErr } = await supabase
      .from("saved_calculations")
      .select("id, tool_name, calculation_data_json, user_email, user_name")
      .eq("id", data.calculationId)
      .eq("visitor_id", data.visitorId.trim())
      .maybeSingle()

    if (readErr) {
      console.error("[calculators.emailCalculationResults] read refused:", readErr.message)
      return { success: false, error: "Could not load that calculation." }
    }

    if (!calculation) {
      return { success: false, error: "Calculation not found" }
    }

    // The destination is the address on the record, never the caller's.
    const onRecord = (calculation.user_email ?? "").trim().toLowerCase()
    if (!onRecord) {
      return {
        success: false,
        error: "This calculation was saved without an email address, so there is nowhere to send it.",
      }
    }
    const asked = (data.recipientEmail ?? "").trim().toLowerCase()
    if (asked && asked !== onRecord) {
      return {
        success: false,
        error: "A calculation can only be emailed to the address it was saved with.",
      }
    }

    // saved_calculations columns are tool_name and calculation_data_json. This
    // read used calculation.tool_type and calculation.results — NEITHER exists
    // on the table, so both were undefined and the email rendered a heading of
    // "Your undefined Results" over a body of `undefined`.
    const { sendCalculatorResults } = await import("@/lib/services/communication.service")
    const emailResult = await sendCalculatorResults({
      email: onRecord,
      calculationType: calculation.tool_name,
      results: calculation.calculation_data_json,
      calculationId: data.calculationId,
    })

    if (!emailResult.success) {
      return { success: false, error: "The email provider refused the message." }
    }

    // THE tool_shares TRACKING WRITE WAS REMOVED — verdict: delete the dead write.
    //
    // Removing the calculator share feature left getSharedCalculation gone, and
    // it was the only reader tool_shares ever had. This insert was the last
    // writer, which made tool_shares a WRITE-ONLY table: a row recorded for a
    // send that no surface, report or export ever consults. The orphan-writes
    // guard flagged exactly that and asked for a verdict.
    //
    // Building a reader was not an option — the owner ruled calculator sharing
    // out — and repointing it would mean inventing a consumer for a record
    // nobody asked for. The send itself is NOT untracked: sendCalculatorResults
    // goes through the shared email service, which is where an outbound message
    // belongs on the record. A bespoke second ledger for one tool was always the
    // odd one out.
    //
    // tool_shares now has no reader and no writer anywhere in the tree. Dropping
    // the table is a migration and a separate decision; it is deliberately NOT
    // done here on my own authority.

    return {
      success: true,
      message: `Calculation emailed to ${onRecord}`,
    }
  } catch (error) {
    console.error("[v0] Error in emailCalculationResults:", error)
    return { success: false, error: "Failed to email calculation" }
  }
}
