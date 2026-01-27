"use server"

import { createClient } from "@/lib/supabase/server"
import { generateAIJSON } from "@/app/actions/ai-generate"

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
}) {
  const supabase = await createClient()

  const costs = {
    agent_commission: data.homeValue * 0.06, // 6% transparent commission
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

export async function compareNeighborhoods(neighborhoods: string[], city: string, state: string) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const idxClient = new IDXBrokerClient()

  const comparison = await Promise.all(
    neighborhoods.map(async (neighborhood) => {
      // Get market stats from IDX
      const marketStats = await idxClient.getProperties({
        city,
        status: "sold",
      })

      // Get neighborhood guide data if exists
      const { data: guideData } = await supabase
        .from("neighborhood_guides")
        .select("*")
        .eq("neighborhood_name", neighborhood)
        .maybeSingle()

      const soldProperties = marketStats || []
      const medianPrice =
        soldProperties.length > 0
          ? soldProperties.reduce((sum: number, p: any) => sum + (p.soldPrice || 0), 0) / soldProperties.length
          : 0

      return {
        name: neighborhood,
        median_price: Math.round(medianPrice),
        active_listings: 0, // Would need active listings query
        price_trend: guideData?.price_trend || "stable",
        school_rating: guideData?.school_rating || 7,
        crime_rating: guideData?.crime_rating || "B",
        walkability_score: guideData?.walkability_score || 50,
        commute_to_downtown: guideData?.commute_minutes || 20,
        vibe: guideData?.vibe_description || "Family-friendly suburban area",
        pros: guideData?.pros || ["Good schools", "Safe streets", "Parks nearby"],
        cons: guideData?.cons || ["Longer commute", "Limited nightlife"],
      }
    }),
  )

  const prompt = `You are a neighborhood expert. Compare these neighborhoods:

${JSON.stringify(comparison, null, 2)}

Provide unbiased analysis for different buyer types:
- Young families (schools, safety, parks)
- Empty nesters (low maintenance, walkability, amenities)
- First-time buyers (affordability, appreciation potential)
- Investors (rental demand, price trends)

Respond with JSON:
{
  "recommendations": {
    "young_families": {
      "best_fit": "Oak Hills",
      "reasoning": "Top-rated schools, low crime, family amenities"
    },
    "empty_nesters": {
      "best_fit": "Downtown District",
      "reasoning": "Walkable, low maintenance condos, cultural amenities"
    },
    "first_time_buyers": {
      "best_fit": "Riverside",
      "reasoning": "Most affordable with good appreciation potential"
    },
    "investors": {
      "best_fit": "University District",
      "reasoning": "Strong rental demand, consistent appreciation"
    }
  },
  "overall_winner": "Oak Hills",
  "best_value": "Riverside"
}`

  try {
    const aiSummary = await generateAIJSON(prompt)

    return {
      success: true,
      comparison,
      ai_recommendations: aiSummary.data?.recommendations,
      overall_winner: aiSummary.data?.overall_winner,
      best_value: aiSummary.data?.best_value,
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

export async function calculateHomeValue(address: string, visitorId?: string) {
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const { BatchDataClient } = await import("@/lib/batchdata-client")

  const idxClient = new IDXBrokerClient()
  const batchData = new BatchDataClient()

  const vid = visitorId || generateVisitorId()

  try {
    // Get property details and comparables
    const [property, comps, propertyData] = await Promise.all([
      idxClient.searchByAddress(address),
      idxClient.getProperties({ status: "sold" }),
      batchData.searchByAddress(address, "", ""),
    ])

    // AI-powered valuation
    const prompt = `You are a real estate valuation expert. Calculate home value:

Subject Property: ${address}
${JSON.stringify(property?.[0] || {})}

Comparable Sales (Recent):
${comps
  ?.slice(0, 10)
  .map(
    (c: any) => `
${c.address}: Sold $${c.soldPrice?.toLocaleString()} - ${c.bedrooms}bd/${c.bathrooms}ba, ${c.sqft} sqft
`,
  )
  .join("\n")}

Property Intelligence:
${JSON.stringify(propertyData?.[0] || {})}

Provide comprehensive valuation:

{
  "estimated_value": 465000,
  "value_range": {"low": 455000, "high": 475000},
  "confidence": "high",
  "key_factors": [
    "Recent comp sold $468k on same street",
    "Property has updated kitchen (+$15k value)",
    "Market appreciating 6% annually"
  ],
  "market_conditions": "balanced",
  "days_on_market_prediction": 28,
  "price_per_sqft": 245,
  "rental_income_estimate": 2800,
  "equity_potential": "If owned 5 years, estimated $85k appreciation",
  "value_boosting_improvements": [
    {"improvement": "Kitchen remodel", "cost": 25000, "value_added": 35000, "roi": 1.4},
    {"improvement": "Bathroom upgrade", "cost": 15000, "value_added": 18000, "roi": 1.2}
  ],
  "neighborhood_trends": "Appreciating 2% above city average",
  "comparable_analysis": "Your home is priced competitively with recent sales",
  "selling_recommendation": "Good time to sell - market balanced with low inventory"
}`

    const valuation = await generateAIJSON(prompt)

    if (!valuation.data) {
      throw new Error("Valuation failed")
    }

    // Track usage anonymously
    await trackToolUsage({
      tool: "home_value",
      visitorId: vid,
      inputs: { address },
      location: property?.[0]?.city,
    })

    return {
      success: true,
      property: property?.[0],
      valuation: valuation.data,
      comparables: comps?.slice(0, 5),
      visitorId: vid,
      disclaimer: "This is an estimated market value based on comparable sales and market data. Not an official appraisal.",
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
      closing_costs: Math.round(maxHomePrice * 0.03),
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
}) {
  const vid = data.visitorId || generateVisitorId()

  const appreciationRate = data.annualAppreciation || 0.03 // 3% default
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
  let totalOwnershipCost = data.downPayment + data.homePrice * 0.03 // Down payment + closing costs
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
  const netProceedsAfterSelling = homeValueAfterYears - loanAmount - homeValueAfterYears * 0.06 // After commission

  const breakEvenPoint = Math.ceil(
    (data.downPayment + data.homePrice * 0.03) / ((totalMonthlyOwnership - data.rentAmount) * 12 + data.homePrice * appreciationRate),
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

export async function shareCalculation(data: { calculationId: string; shareWithEmail?: string }) {
  const supabase = await createClient()

  try {
    // Generate unique share link
    const shareToken = `share_${Date.now()}_${Math.random().toString(36).substring(7)}`

    const { data: share, error } = await supabase
      .from("tool_shares")
      .insert({
        calculation_id: data.calculationId,
        share_token: shareToken,
        shared_with_email: data.shareWithEmail || null,
      })
      .select()
      .single()

    if (error) {
      console.error("[v0] Error creating share link:", error)
      return { success: false, error: "Failed to create share link" }
    }

    const shareUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://yourdomain.com"}/tools/shared/${shareToken}`

    return {
      success: true,
      shareUrl,
      shareToken,
      message: "Share link created! Anyone with this link can view the calculation.",
    }
  } catch (error) {
    console.error("[v0] Error in shareCalculation:", error)
    return { success: false, error: "Failed to create share link" }
  }
}

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

export async function getSharedCalculation(shareToken: string) {
  const supabase = await createClient()

  try {
    const { data: share, error: shareError } = await supabase
      .from("tool_shares")
      .select(
        `
        *,
        saved_calculations(*)
      `,
      )
      .eq("share_token", shareToken)
      .maybeSingle()

    if (shareError || !share) {
      return { success: false, error: "Share link not found or expired" }
    }

    // Track view
    await supabase
      .from("tool_shares")
      .update({
        view_count: (share.view_count || 0) + 1,
        last_viewed_at: new Date().toISOString(),
      })
      .eq("id", share.id)

    return {
      success: true,
      calculation: share.saved_calculations,
      sharedBy: share.saved_calculations?.user_name || "Anonymous",
    }
  } catch (error) {
    console.error("[v0] Error in getSharedCalculation:", error)
    return { success: false, error: "Failed to load shared calculation" }
  }
}

export async function emailCalculationResults(data: {
  calculationId: string
  recipientEmail: string
  recipientName?: string
}) {
  const supabase = await createClient()

  try {
    const { data: calculation } = await supabase
      .from("saved_calculations")
      .select("*")
      .eq("id", data.calculationId)
      .maybeSingle()

    if (!calculation) {
      return { success: false, error: "Calculation not found" }
    }

    // Send calculation results via email
    const { sendCalculatorResults } = await import("@/lib/services/communication.service")
    const emailResult = await sendCalculatorResults({
      email: data.recipientEmail,
      calculationType: calculation.tool_type,
      results: calculation.results,
      calculationId: data.calculationId,
    })

    // Track the email request
    await supabase.from("tool_shares").insert({
      calculation_id: data.calculationId,
      shared_with_email: data.recipientEmail,
      share_token: `email_${Date.now()}`,
      sent_at: new Date().toISOString(),
    })

    return {
      success: emailResult.success,
      message: `Calculation emailed to ${data.recipientEmail}`,
    }
  } catch (error) {
    console.error("[v0] Error in emailCalculationResults:", error)
    return { success: false, error: "Failed to email calculation" }
  }
}
