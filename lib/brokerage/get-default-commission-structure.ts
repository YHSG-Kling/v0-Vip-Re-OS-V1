/**
 * SYSTEM 7.2 Extension — Commission Structure Resolver
 *
 * Provides brokerage-specific commission rates and splits.
 * Eliminates ALL hardcoded 0.03, 0.06, 0.7/0.3 assumptions.
 *
 * Rules:
 * - All functions require brokerageId (multi-tenant platform)
 * - No fallback rates — throw error if not configured
 * - Commission authority is always internal (commission_structures table owns rates)
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface CommissionStructure {
  id: string
  brokerage_id: string
  name: string
  is_default: boolean
  
  // Listing side (seller agent commission)
  listing_commission_rate: number // Total listing side (e.g. 0.03 = 3%)
  listing_agent_split: number // Agent's % of listing commission (e.g. 0.70 = 70%)
  listing_brokerage_split: number // Brokerage's % (e.g. 0.30 = 30%)
  
  // Buyer side (buyer agent commission)
  buyer_commission_rate: number // Total buyer side (e.g. 0.03 = 3%)
  buyer_agent_split: number // Agent's % of buyer commission (e.g. 0.70 = 70%)
  buyer_brokerage_split: number // Brokerage's % (e.g. 0.30 = 30%)
  
  // Derived helpers (computed, not stored)
  totalListingSideRate: number // listing_commission_rate
  totalBuyerSideRate: number // buyer_commission_rate
  agentListingSideRate: number // listing_commission_rate * listing_agent_split
  brokerageListingSideRate: number // listing_commission_rate * listing_brokerage_split
  agentBuyerSideRate: number // buyer_commission_rate * buyer_agent_split
  brokerageBuyerSideRate: number // buyer_commission_rate * buyer_brokerage_split
}

/**
 * Get the default commission structure for a brokerage.
 *
 * Throws error if not configured — no hardcoded fallbacks.
 *
 * @param brokerageId - UUID of the brokerage
 * @returns Commission structure with computed helper fields
 */
export async function getDefaultCommissionStructure(
  brokerageId: string
): Promise<CommissionStructure> {
  if (!brokerageId) {
    throw new Error("[commission-resolver] brokerageId is required")
  }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("commission_structures")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("is_default", true)
    .single()

  if (error || !data) {
    throw new Error(
      `[commission-resolver] No default commission structure found for brokerage ${brokerageId}. ` +
      `Create a commission structure with is_default=true before running commission calculations.`
    )
  }

  // Add computed helper fields for convenience
  return {
    ...data,
    totalListingSideRate: data.listing_commission_rate,
    totalBuyerSideRate: data.buyer_commission_rate,
    agentListingSideRate: data.listing_commission_rate * data.listing_agent_split,
    brokerageListingSideRate: data.listing_commission_rate * data.listing_brokerage_split,
    agentBuyerSideRate: data.buyer_commission_rate * data.buyer_agent_split,
    brokerageBuyerSideRate: data.buyer_commission_rate * data.buyer_brokerage_split,
  }
}

/**
 * Get all commission structures for a brokerage (default + custom).
 *
 * @param brokerageId - UUID of the brokerage
 * @returns Array of commission structures with computed fields
 */
export async function getAllCommissionStructures(
  brokerageId: string
): Promise<CommissionStructure[]> {
  if (!brokerageId) {
    throw new Error("[commission-resolver] brokerageId is required")
  }

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

  if (!data || data.length === 0) {
    throw new Error(
      `[commission-resolver] No commission structures found for brokerage ${brokerageId}`
    )
  }

  return data.map((structure) => ({
    ...structure,
    totalListingSideRate: structure.listing_commission_rate,
    totalBuyerSideRate: structure.buyer_commission_rate,
    agentListingSideRate: structure.listing_commission_rate * structure.listing_agent_split,
    brokerageListingSideRate: structure.listing_commission_rate * structure.listing_brokerage_split,
    agentBuyerSideRate: structure.buyer_commission_rate * structure.buyer_agent_split,
    brokerageBuyerSideRate: structure.buyer_commission_rate * structure.buyer_brokerage_split,
  }))
}
