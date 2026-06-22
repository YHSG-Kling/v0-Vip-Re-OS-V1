/**
 * Pure net-sheet math — no DB, no Supabase, no async.
 *
 * Extracted from app/actions/cma-presentation/net-sheet-calculator.ts so the
 * scenario arithmetic can be unit-simulated in isolation. The server action
 * delegates the per-scenario calculation here; all brokerage data
 * (commission rates, closing-cost percent) is resolved upstream and passed in.
 */

export interface NetSheetCostInputs {
  closingCosts?: number
  mortgagePayoffAmount?: number
  mortgageBalance?: number
  propertyTaxes?: number
  hoaFees?: number
  repairCredits?: number
  sellerConcessions?: number
}

export interface NetSheetScenarioMath {
  scenarioName: string
  salePrice: number
  grossProceeds: number
  totalCosts: number
  netProceeds: number
  breakdown: {
    salePrice: number
    listingCommission: number
    buyerCommission: number
    closingCosts: number
    mortgagePayoff: number
    propertyTaxes: number
    hoaFees: number
    repairCredits: number
    sellerConcessions: number
    otherCosts: number
  }
}

/**
 * Compute a single net-sheet scenario.
 *
 * @param scenarioName      human label for the scenario
 * @param salePrice         the sale price for THIS scenario (already adjusted for -5%/+5% etc.)
 * @param costs             optional fixed-dollar cost overrides
 * @param listingSideRate   listing-side commission rate as a fraction (e.g. 0.03)
 * @param buyerSideRate     buyer-side commission rate as a fraction (e.g. 0.03)
 * @param closingCostPercent closing-cost percent as a fraction (e.g. 0.02), used when no fixed closingCosts provided
 */
export function computeNetSheetScenario(
  scenarioName: string,
  salePrice: number,
  costs: NetSheetCostInputs,
  listingSideRate: number,
  buyerSideRate: number,
  closingCostPercent: number,
): NetSheetScenarioMath {
  const listingCommission = salePrice * (listingSideRate ?? 0)
  const buyerCommission = salePrice * (buyerSideRate ?? 0)

  // Fixed dollar closing costs take precedence; otherwise derive from percent.
  const closingCosts = costs.closingCosts ?? salePrice * closingCostPercent
  const mortgagePayoff = costs.mortgagePayoffAmount || costs.mortgageBalance || 0
  const propertyTaxes = costs.propertyTaxes || 0
  const hoaFees = costs.hoaFees || 0
  const repairCredits = costs.repairCredits || 0
  const sellerConcessions = costs.sellerConcessions || 0

  const totalCosts =
    listingCommission +
    buyerCommission +
    closingCosts +
    mortgagePayoff +
    propertyTaxes +
    hoaFees +
    repairCredits +
    sellerConcessions

  const netProceeds = salePrice - totalCosts

  return {
    scenarioName,
    salePrice,
    grossProceeds: salePrice,
    totalCosts,
    netProceeds,
    breakdown: {
      salePrice,
      listingCommission,
      buyerCommission,
      closingCosts,
      mortgagePayoff,
      propertyTaxes,
      hoaFees,
      repairCredits,
      sellerConcessions,
      otherCosts: 0,
    },
  }
}
