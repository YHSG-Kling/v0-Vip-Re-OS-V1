/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * CMA Quality Evaluator
 * 
 * Evaluates CMA readiness and quality based on:
 * - Minimum comparable count
 * - Recency threshold
 * - Radius coverage
 * - Agent OR broker approval
 * 
 * This is GOVERNANCE ONLY - no CMA calculations, no data fetching
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

export interface CMAQualityInput {
  listingId: string
  brokerage_id?: string
  
  // CMA metadata (derived from activities or passed in)
  comparableCount?: number
  oldestComparableMonths?: number
  maxRadiusMiles?: number
  agentApproved?: boolean
  brokerApproved?: boolean
  
  // Override context
  overrideByRole?: "agent" | "team_lead" | "broker" | "admin"
  overrideReason?: string
}

export interface CMAQualityResult {
  isReady: boolean
  qualityScore: number // 0-100
  
  checks: {
    minimumComparables: boolean
    recencyThreshold: boolean
    radiusCoverage: boolean
    approvalReceived: boolean
  }
  
  violations: string[]
  warnings: string[]
  
  // Override tracking
  wasOverridden: boolean
  overrideBy?: string
  overrideReason?: string
}

/**
 * Default quality thresholds (can be overridden by brokerage policy)
 */
const DEFAULT_THRESHOLDS = {
  minimumComparables: 3,
  maxRecencyMonths: 6,
  maxRadiusMiles: 2.0,
  requiresApproval: true,
}

/**
 * Evaluate CMA quality and readiness
 */
export async function evaluateCMAQuality(input: CMAQualityInput): Promise<CMAQualityResult> {
  // Validation
  if (!isValidUUID(input.listingId)) {
    return {
      isReady: false,
      qualityScore: 0,
      checks: {
        minimumComparables: false,
        recencyThreshold: false,
        radiusCoverage: false,
        approvalReceived: false,
      },
      violations: ["Invalid listing ID"],
      warnings: [],
      wasOverridden: false,
    }
  }
  
  // Check for explicit override
  if (input.overrideByRole && ["broker", "admin"].includes(input.overrideByRole)) {
    return {
      isReady: true,
      qualityScore: 100,
      checks: {
        minimumComparables: true,
        recencyThreshold: true,
        radiusCoverage: true,
        approvalReceived: true,
      },
      violations: [],
      warnings: ["Quality checks overridden by " + input.overrideByRole],
      wasOverridden: true,
      overrideBy: input.overrideByRole,
      overrideReason: input.overrideReason || "No reason provided",
    }
  }
  
  // Perform quality checks
  const checks = {
    minimumComparables: (input.comparableCount || 0) >= DEFAULT_THRESHOLDS.minimumComparables,
    recencyThreshold: (input.oldestComparableMonths || 999) <= DEFAULT_THRESHOLDS.maxRecencyMonths,
    radiusCoverage: (input.maxRadiusMiles || 999) <= DEFAULT_THRESHOLDS.maxRadiusMiles,
    approvalReceived: input.agentApproved || input.brokerApproved || false,
  }
  
  const violations: string[] = []
  const warnings: string[] = []
  
  if (!checks.minimumComparables) {
    violations.push(
      `Insufficient comparables: ${input.comparableCount || 0} (minimum ${DEFAULT_THRESHOLDS.minimumComparables})`
    )
  }
  
  if (!checks.recencyThreshold) {
    violations.push(
      `Comparables too old: ${input.oldestComparableMonths || "unknown"} months (maximum ${DEFAULT_THRESHOLDS.maxRecencyMonths})`
    )
  }
  
  if (!checks.radiusCoverage) {
    warnings.push(
      `Search radius too wide: ${input.maxRadiusMiles || "unknown"} miles (recommended ${DEFAULT_THRESHOLDS.maxRadiusMiles})`
    )
  }
  
  if (!checks.approvalReceived) {
    violations.push("CMA requires agent or broker approval")
  }
  
  // Calculate quality score
  const passedChecks = Object.values(checks).filter(Boolean).length
  const totalChecks = Object.keys(checks).length
  const qualityScore = Math.round((passedChecks / totalChecks) * 100)
  
  const isReady = violations.length === 0
  
  return {
    isReady,
    qualityScore,
    checks,
    violations,
    warnings,
    wasOverridden: false,
  }
}

/**
 * Derive CMA quality from activities events
 */
export async function deriveCMAQualityFromEvents(listingId: string): Promise<CMAQualityInput | null> {
  if (!isValidUUID(listingId)) {
    return null
  }
  
  const supabase = await createClient()
  
  // Query activities for CMA-related events
  const { data: events, error } = await supabase
    .from("activities")
    .select("activity_type, metadata, created_at")
    .eq("listing_id", listingId)
    .or("activity_type.eq.seller.cma.generated,activity_type.eq.seller.cma.approved,activity_type.eq.seller.cma.quality_verified")
    .order("created_at", { ascending: false })
    .limit(10)
  
  if (error || !events || events.length === 0) {
    return null
  }
  
  // Extract CMA metadata from most recent events
  let comparableCount: number | undefined
  let oldestComparableMonths: number | undefined
  let maxRadiusMiles: number | undefined
  let agentApproved = false
  let brokerApproved = false
  
  for (const event of events) {
    const meta = event.metadata as any
    
    if (event.activity_type === "seller.cma.generated" && meta) {
      comparableCount = meta.comparable_count || meta.comparableCount
      oldestComparableMonths = meta.oldest_comparable_months || meta.oldestComparableMonths
      maxRadiusMiles = meta.max_radius_miles || meta.maxRadiusMiles
    }
    
    if (event.activity_type === "seller.cma.approved" && meta) {
      if (meta.approved_by_role === "agent" || meta.approvedByRole === "agent") {
        agentApproved = true
      }
      if (meta.approved_by_role === "broker" || meta.approvedByRole === "broker") {
        brokerApproved = true
      }
    }
    
    if (event.activity_type === "seller.cma.quality_verified") {
      agentApproved = true // Quality verification implies agent approval
    }
  }
  
  return {
    listingId,
    comparableCount,
    oldestComparableMonths,
    maxRadiusMiles,
    agentApproved,
    brokerApproved,
  }
}

/**
 * Check if CMA is ready (quick check)
 */
export async function isCMAReady(listingId: string): Promise<boolean> {
  const input = await deriveCMAQualityFromEvents(listingId)
  if (!input) return false
  
  const result = await evaluateCMAQuality(input)
  return result.isReady
}
