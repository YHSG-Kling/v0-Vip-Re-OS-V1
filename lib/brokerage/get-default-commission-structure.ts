/**
 * Phase 2 — Commission Structure Resolver (Build13 Aligned)
 *
 * Queries agent_commission_profiles + commission_structures
 * using build13 schema columns.
 *
 * RULES:
 * - base_percentage stored as whole number (3 = 3%)
 * - split_percent stored as whole number (80 = 80%)
 * - Convert to decimal via / 100
 * - Returns whole dollar fees (no cents conversion yet)
 * - Agent identity = agents.id (never users.id)
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface CommissionStructure {
  // Rates (decimal)
  agentBuyerSideRate: number      // What agent earns on buyer side
  agentListingSideRate: number    // What agent earns on listing side
  brokerageBuyerSideRate: number  // What brokerage keeps on buyer side
  brokerageListingSideRate: number// What brokerage keeps on listing side
  totalBuyerSideRate: number      // Total commission rate buyer side
  totalListingSideRate: number    // Total commission rate listing side
  
  // Fees (whole dollars)
  transactionFeeValue: number
  transactionFeeType: string | null
  deskFeeValue: number
  deskFeeType: string | null
  technologyFeeValue: number
  technologyFeeType: string | null
  eoFeeValue: number
  eoFeeType: string | null
  royaltyValue: number
  royaltyType: string | null
  referralValue: number
  referralType: string | null
  residualValue: number
  residualType: string | null
  
  // Metadata
  capAmount: number | null
  structureType: string | null
}

/**
 * Get agent commission profile + brokerage default structure
 * 
 * @param agentId - agents.id (NOT users.id)
 * @param brokerageId - brokerage_id for multi-tenant filter
 */
export async function getDefaultCommissionStructure(
  brokerageId: string,
  agentId?: string
): Promise<CommissionStructure> {
  const supabase = createServiceClient()

  // Get agent profile if agentId provided
  let agentProfile = null
  if (agentId) {
    const { data } = await supabase
      .from("agent_commission_profiles")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("effective_date", { ascending: false })
      .limit(1)
      .maybeSingle()
    
    agentProfile = data
  }

  // Get brokerage default structure
  const { data: structure, error } = await supabase
    .from("commission_structures")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("is_default", true)
    .eq("is_active", true)
    .single()

  if (error || !structure) {
    throw new Error(
      `[commission-resolver] No default commission structure found for brokerage ${brokerageId}`
    )
  }

  // Convert base_percentage (whole number → decimal)
  const grossRate = (structure.base_percentage || 0) / 100

  // If agent profile exists, use their split; otherwise use 70% default
  const agentSplit = agentProfile
    ? (agentProfile.split_percent || 0) / 100
    : 0.7

  // Agent gets agentSplit, brokerage gets remainder
  const agentBuyerSideRate = grossRate * agentSplit
  const brokerageBuyerSideRate = grossRate * (1 - agentSplit)

  // Assume listing side same as buyer side unless overridden
  const agentListingSideRate = agentBuyerSideRate
  const brokerageListingSideRate = brokerageBuyerSideRate

  // Extract fees from agent profile (prefer new _value columns)
  const transactionFeeValue = agentProfile?.transaction_fee_value ?? agentProfile?.transaction_fee ?? 0
  const deskFeeValue = agentProfile?.desk_fee_value ?? 0
  const technologyFeeValue = agentProfile?.technology_fee_value ?? 0
  const eoFeeValue = agentProfile?.eo_fee_value ?? 0
  const royaltyValue = agentProfile?.royalty_value ?? 0
  const referralValue = agentProfile?.referral_value ?? 0
  const residualValue = agentProfile?.residual_value ?? 0

  return {
    agentBuyerSideRate,
    agentListingSideRate,
    brokerageBuyerSideRate,
    brokerageListingSideRate,
    totalBuyerSideRate: grossRate,
    totalListingSideRate: grossRate,
    
    transactionFeeValue,
    transactionFeeType: agentProfile?.transaction_fee_type ?? null,
    deskFeeValue,
    deskFeeType: agentProfile?.desk_fee_type ?? null,
    technologyFeeValue,
    technologyFeeType: agentProfile?.technology_fee_type ?? null,
    eoFeeValue,
    eoFeeType: agentProfile?.eo_fee_type ?? null,
    royaltyValue,
    royaltyType: agentProfile?.royalty_type ?? null,
    referralValue,
    referralType: agentProfile?.referral_type ?? null,
    residualValue,
    residualType: agentProfile?.residual_type ?? null,
    
    capAmount: agentProfile?.cap_amount ?? null,
    structureType: agentProfile?.structure_type ?? null,
  }
}

/**
 * Get all commission structures for a brokerage
 */
export async function getAllCommissionStructures(
  brokerageId: string
): Promise<any[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("commission_structures")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("is_default", { ascending: false })

  if (error) {
    throw new Error(
      `[commission-resolver] Failed to load commission structures: ${error.message}`
    )
  }

  return data || []
}
