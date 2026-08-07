"use server"

import { createClient } from "@/lib/supabase/server"
import { generateAIJSON } from "@/lib/ai"
import { getDefaultCommissionStructure } from "@/lib/brokerage"

// ============================================
// SELLER NET PROCEEDS CALCULATOR
// ============================================

async function getLocalTitleCost(location: string, homeValue: number): Promise<number> {
  // Title insurance typically ranges from 0.5% to 1% of home value
  return homeValue * 0.007
}

async function getLocalEscrowFees(location: string, homeValue: number): Promise<number> {
  // Escrow fees typically range from 1-2% of home value
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
    title_insurance: await getLocalTitleCost(data.location, data.homeValue),
    escrow_fees: await getLocalEscrowFees(data.location, data.homeValue),
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
  const idxClient = new IDXBrokerClient()
  const idxConfigured = idxClient.isConfigured()

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

      // Real active-listing count. This is the brokerage's IDX-enabled active
      // listings, not total market inventory — `active_listings_source` says so.
      // With no IDX key the search returns [], which would read as a measured
      // zero, so an unconfigured client yields null instead.
      const listings = idxConfigured
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

// Get all calculator results for a lead (store history)
export async function getCalculatorHistory(leadId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("calculator_history")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) {
    console.error("[v0] Error fetching calculator history:", error)
    return []
  }

  return data || []
}

// Save calculator results for lead tracking
export async function saveCalculatorResult(data: {
  leadId: string
  calculatorType: "seller_net" | "mortgage_comparison" | "neighborhood_compare" | "investment_analyzer" | "moving_cost"
  inputs: any
  results: any
}) {
  const supabase = await createClient()

  const { error } = await supabase.from("calculator_history").insert({
    lead_id: data.leadId,
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

// Track tool usage anonymously
async function trackToolUsage(data: {
  tool: string
  visitorId: string
  inputs: any
  location?: string
  timeSpent?: number
}) {
  const supabase = await createClient()

  try {
    await supabase.from("tool_usage_sessions").insert({
      tool_name: data.tool,
      visitor_id: data.visitorId,
      session_data_json: { inputs: data.inputs, location: data.location },
      time_spent_seconds: data.timeSpent || 0,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    // Silently fail - don't block user experience
    console.error("[v0] Tool tracking failed:", e)
  }
}

// Generate or retrieve anonymous visitor ID
function generateVisitorId(): string {
  return `visitor_${Date.now()}_${Math.random().toString(36).substring(7)}`
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
 * `brokerageId` and `state` are required inputs. They are NOT derivable from an
 * address string and are not substituted from any other id space — the caller
 * must supply them.
 */
export async function calculateHomeValue(
  address: string,
  opts: {
    /** Required by runAiCma — the brokerage the CMA is run under. */
    brokerageId: string
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

  const idxClient = new IDXBrokerClient()
  const batchData = new BatchDataClient()

  const vid = opts.visitorId || generateVisitorId()

  try {
    const [property, propertyData, cma] = await Promise.all([
      idxClient.searchProperties(address),
      batchData.searchByAddress(address, opts.city ?? "", opts.state),
      runAiCma({
        mode: "standard",
        brokerageId: opts.brokerageId,
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

    // Track usage anonymously regardless of whether comps were found.
    await trackToolUsage({
      tool: "home_value",
      visitorId: vid,
      inputs: { address, city: opts.city ?? null, state: opts.state, zipCode: opts.zipCode ?? null },
      location: opts.city ?? undefined,
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

  // Track usage
  await trackToolUsage({
    tool: "affordability",
    visitorId: vid,
    inputs: data,
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

  // Track usage
  await trackToolUsage({
    tool: "rent_vs_buy",
    visitorId: vid,
    inputs: data,
    location: data.city,
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

export async function saveCalculation(data: {
  toolName: string
  calculationData: any
  visitorId: string
  email?: string
  name?: string
}) {
  const supabase = await createClient()

  try {
    const { data: saved, error } = await supabase
      .from("saved_calculations")
      .insert({
        tool_name: data.toolName,
        visitor_id: data.visitorId,
        calculation_data_json: data.calculationData,
        user_email: data.email || null,
        user_name: data.name || null,
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


export async function getSavedCalculations(visitorId: string) {
  const supabase = await createClient()

  try {
    const { data, error } = await supabase
      .from("saved_calculations")
      .select("*")
      .eq("visitor_id", visitorId)
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
 *   2. PII EXFILTRATION. The row carries user_email and user_name. RLS does
 *      NOT stop this read: the live SELECT policy is
 *      `is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)`
 *      and saveCalculation() above never sets brokerage_id — so EVERY row in
 *      this table is anon-readable by that second clause. Verified against the
 *      live schema, not assumed.
 *
 * The fix keeps the lane public (requiring a login would defeat a lead-magnet
 * calculator) but binds both ends to something the caller must already hold:
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
