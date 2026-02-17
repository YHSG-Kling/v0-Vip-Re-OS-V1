"use server"

/**
 * System 5.3: CMA & Listing Presentation Engine
 * Net Sheet Calculator
 * 
 * Calculates seller proceeds for multiple scenarios.
 * DOES NOT advance journey - only emits completion signals.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"

export interface NetSheetInput {
  listingId: string
  contactId: string
  agentId: string
  
  // Sale scenarios
  salePrice: number
  alternatePrice?: number // For "what if" scenarios
  
  // Costs
  listingCommissionRate?: number // Default 3%
  buyerCommissionRate?: number // Default 3%
  closingCosts?: number // Default 2% of sale price
  
  // Existing mortgage
  mortgageBalance?: number
  mortgagePayoffAmount?: number
  
  // Other costs
  propertyTaxes?: number
  hoaFees?: number
  repairCredits?: number
  sellerConcessions?: number
}

export interface NetSheetResult {
  success: boolean
  netSheetId?: string
  scenarios?: NetSheetScenario[]
  expiresAt?: string
  error?: string
}

export interface NetSheetScenario {
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
 * NET SHEET VALIDITY: 90 days from generation
 */
const NET_SHEET_VALIDITY_DAYS = 90

/**
 * Generate net sheet with multiple scenarios
 */
export async function generateNetSheet(input: NetSheetInput): Promise<NetSheetResult> {
  try {
    // Validation
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    if (!isValidUUID(input.contactId)) {
      return { success: false, error: "Invalid contact ID" }
    }
    if (!isValidUUID(input.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }
    if (!input.salePrice || input.salePrice <= 0) {
      return { success: false, error: "Invalid sale price" }
    }

    const supabase = await createClient()

    // Get agent's brokerage for commission structure
    const { data: profile } = await supabase
      .from("profiles")
      .select("brokerage_id")
      .eq("id", input.agentId)
      .single()

    const brokerageId = profile?.brokerage_id
    if (!brokerageId) {
      return { success: false, error: "Agent brokerage not found" }
    }

    // Get brokerage commission structure
    const commissionStructure = await getDefaultCommissionStructure(brokerageId)

    // Emit start event
    await supabase.from("activities").insert({
      type: "seller.net_sheet.started",
      listing_id: input.listingId,
      contact_id: input.contactId,
      user_id: input.agentId,
      metadata: {
        sale_price: input.salePrice,
        alternate_price: input.alternatePrice
      }
    })

    // Calculate scenarios
    const scenarios: NetSheetScenario[] = []
    
    // Primary scenario
    scenarios.push(calculateScenario("Primary Scenario", input.salePrice, input, commissionStructure))
    
    // Alternate scenario if provided
    if (input.alternatePrice && input.alternatePrice > 0) {
      scenarios.push(calculateScenario("Alternate Scenario", input.alternatePrice, input, commissionStructure))
    }
    
    // Conservative scenario (-5%)
    scenarios.push(calculateScenario("Conservative (-5%)", input.salePrice * 0.95, input, commissionStructure))
    
    // Optimistic scenario (+5%)
    scenarios.push(calculateScenario("Optimistic (+5%)", input.salePrice * 1.05, input, commissionStructure))

    // Calculate expiration (90 days)
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + NET_SHEET_VALIDITY_DAYS)

    const netSheetId = crypto.randomUUID()

    // Emit completion event
    await supabase.from("activities").insert({
      type: "seller.net_sheet.completed",
      listing_id: input.listingId,
      contact_id: input.contactId,
      user_id: input.agentId,
      metadata: {
        net_sheet_id: netSheetId,
        scenario_count: scenarios.length,
        primary_net_proceeds: scenarios[0].netProceeds,
        expires_at: expiresAt.toISOString(),
        validity_days: NET_SHEET_VALIDITY_DAYS
      }
    })

    return {
      success: true,
      netSheetId,
      scenarios,
      expiresAt: expiresAt.toISOString()
    }
  } catch (error: any) {
    console.error("[System 5.3] Net sheet generation error:", error)
    return {
      success: false,
      error: error.message || "Failed to generate net sheet"
    }
  }
}

/**
 * Calculate a single net sheet scenario
 * Note: Commission rates should be passed from generateNetSheet after fetching from brokerage settings
 */
function calculateScenario(
  scenarioName: string,
  salePrice: number,
  input: NetSheetInput,
  commissionStructure: Awaited<ReturnType<typeof getDefaultCommissionStructure>>
): NetSheetScenario {
  // Use brokerage commission structure if rates not explicitly provided
  const listingCommissionRate = input.listingCommissionRate || commissionStructure.totalListingSideRate
  const buyerCommissionRate = input.buyerCommissionRate || commissionStructure.totalBuyerSideRate
  
  // Commission Engine 8.0 will compute final values.
  // Use resolver rates from getDefaultCommissionStructure() passed in via commissionStructure.
  const listingCommission = salePrice * (commissionStructure?.agentListingSideRate ?? 0)
  const buyerCommission = salePrice * (commissionStructure?.agentBuyerSideRate ?? 0)
  const closingCosts = input.closingCosts ?? 0
  // TODO: replace closingCosts default with getFinancialDefaults(brokerageId).closingCostPercent
  const mortgagePayoff = input.mortgagePayoffAmount || input.mortgageBalance || 0
  const propertyTaxes = input.propertyTaxes || 0
  const hoaFees = input.hoaFees || 0
  const repairCredits = input.repairCredits || 0
  const sellerConcessions = input.sellerConcessions || 0
  
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
      otherCosts: 0
    }
  }
}

/**
 * Check if net sheet is still valid (within 90 days)
 */
export async function isNetSheetValid(listingId: string): Promise<boolean> {
  try {
    if (!isValidUUID(listingId)) {
      return false
    }

    const supabase = await createClient()

    // Find most recent net sheet completion
    const { data: events } = await supabase
      .from("activities")
      .select("created_at, metadata")
      .eq("listing_id", listingId)
      .eq("type", "seller.net_sheet.completed")
      .order("created_at", { ascending: false })
      .limit(1)

    if (!events || events.length === 0) {
      return false
    }

    const latestEvent = events[0]
    const createdAt = new Date(latestEvent.created_at)
    const now = new Date()
    const daysSinceCreation = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24))

    return daysSinceCreation <= NET_SHEET_VALIDITY_DAYS
  } catch (error) {
    console.error("[System 5.3] Net sheet validation error:", error)
    return false
  }
}

/**
 * Get net sheet expiration status
 */
export async function getNetSheetExpiration(listingId: string): Promise<{
  isValid: boolean
  daysRemaining?: number
  expiresAt?: string
  needsRenewal?: boolean
}> {
  try {
    if (!isValidUUID(listingId)) {
      return { isValid: false }
    }

    const supabase = await createClient()

    const { data: events } = await supabase
      .from("activities")
      .select("created_at, metadata")
      .eq("listing_id", listingId)
      .eq("type", "seller.net_sheet.completed")
      .order("created_at", { ascending: false })
      .limit(1)

    if (!events || events.length === 0) {
      return { isValid: false, needsRenewal: true }
    }

    const latestEvent = events[0]
    const createdAt = new Date(latestEvent.created_at)
    const expiresAt = new Date(createdAt)
    expiresAt.setDate(expiresAt.getDate() + NET_SHEET_VALIDITY_DAYS)
    
    const now = new Date()
    const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    
    const isValid = daysRemaining > 0
    const needsRenewal = daysRemaining <= 7 // Warn when < 7 days remaining

    return {
      isValid,
      daysRemaining: Math.max(0, daysRemaining),
      expiresAt: expiresAt.toISOString(),
      needsRenewal
    }
  } catch (error) {
    console.error("[System 5.3] Net sheet expiration check error:", error)
    return { isValid: false, needsRenewal: true }
  }
}
