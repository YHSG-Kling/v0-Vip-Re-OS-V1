/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * Decision State Definitions
 * 
 * Defines the canonical 8-state seller decision lifecycle with:
 * - Readiness requirements
 * - Authority roles
 * - System gating signals
 * - SLA expectations
 * 
 * This is GOVERNANCE ONLY - no execution logic, no UI, no CMA calculations
 */

export type SellerDecisionState =
  | "SELLER_CMA_REQUIRED"
  | "SELLER_CMA_READY"
  | "SELLER_NET_SHEET_READY"
  | "SELLER_PRESENTATION_ASSEMBLED"
  | "SELLER_PRESENTATION_VIDEO_READY"
  | "SELLER_DECISION_READY"
  | "SELLER_DECISION_DEFERRED"
  | "SELLER_DECISION_DECLINED"

export type RequiredRole = "agent" | "team_lead" | "broker" | "admin"

export interface DecisionStateDefinition {
  state: SellerDecisionState
  label: string
  description: string
  
  // Readiness prerequisites
  prerequisites: {
    cmaReady?: boolean
    netSheetReady?: boolean
    presentationAssembled?: boolean
    presentationVideoReady?: boolean
  }
  
  // Required roles (any of these can transition)
  requiredRoles: RequiredRole[]
  
  // System gating signals this state enables
  enablesSystemGates?: string[]
  
  // Can accept overrides?
  allowsOverride: boolean
  
  // Override authority level required
  overrideRequiredRole?: RequiredRole
  
  // SLA expectation in hours (for reporting/alerting only)
  slaExpectationHours?: number
  
  // Is this a milestone state?
  isMilestone: boolean
  
  // Can this state be reversed?
  allowsReversal: boolean
  
  // If reversal allowed, what's the maximum listing stage?
  reversalMaxStage?: string // ListingStage before MLS_ACTIVE
}

/**
 * Canonical Seller Decision State Definitions
 * 8 states (non-linear progression)
 */
export const SELLER_DECISION_STATES: DecisionStateDefinition[] = [
  {
    state: "SELLER_CMA_REQUIRED",
    label: "CMA Required",
    description: "Seller requires Comparative Market Analysis before decision",
    prerequisites: {},
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["cma_generation"],
    allowsOverride: false,
    slaExpectationHours: 48,
    isMilestone: true,
    allowsReversal: false,
  },
  {
    state: "SELLER_CMA_READY",
    label: "CMA Ready",
    description: "CMA completed and approved, quality verified",
    prerequisites: {
      cmaReady: true,
    },
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    allowsOverride: true,
    overrideRequiredRole: "broker",
    slaExpectationHours: 72,
    isMilestone: true,
    allowsReversal: false,
  },
  {
    state: "SELLER_NET_SHEET_READY",
    label: "Net Sheet Ready",
    description: "Net sheet generated and valid (not expired)",
    prerequisites: {
      netSheetReady: true,
    },
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    allowsOverride: true,
    overrideRequiredRole: "broker",
    slaExpectationHours: 24,
    isMilestone: false,
    allowsReversal: false,
  },
  {
    state: "SELLER_PRESENTATION_ASSEMBLED",
    label: "Presentation Assembled",
    description: "Listing presentation materials assembled",
    prerequisites: {
      presentationAssembled: true,
    },
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["presentation_drip_sequence"],
    allowsOverride: false,
    slaExpectationHours: 48,
    isMilestone: false,
    allowsReversal: false,
  },
  {
    state: "SELLER_PRESENTATION_VIDEO_READY",
    label: "Presentation Video Ready",
    description: "Custom presentation video generated and approved",
    prerequisites: {
      presentationVideoReady: true,
    },
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    allowsOverride: false,
    slaExpectationHours: 24,
    isMilestone: false,
    allowsReversal: false,
  },
  {
    state: "SELLER_DECISION_READY",
    label: "Decision Ready",
    description: "All materials ready, awaiting seller decision",
    prerequisites: {
      cmaReady: true,
      netSheetReady: true,
      presentationAssembled: true,
    },
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["decision_tracking", "drip_pause"],
    allowsOverride: false,
    slaExpectationHours: 168, // 7 days
    isMilestone: true,
    allowsReversal: true,
    reversalMaxStage: "MLS_READY", // Can reverse before MLS_ACTIVE
  },
  {
    state: "SELLER_DECISION_DEFERRED",
    label: "Decision Deferred",
    description: "Seller deferred decision to future date",
    prerequisites: {},
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["drip_continue", "reengagement_sequence"],
    allowsOverride: false,
    isMilestone: false,
    allowsReversal: false,
  },
  {
    state: "SELLER_DECISION_DECLINED",
    label: "Decision Declined",
    description: "Seller declined to list at this time",
    prerequisites: {},
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["drip_pause", "disengagement_sequence"],
    allowsOverride: false,
    isMilestone: true,
    allowsReversal: false,
  },
]

/**
 * Get state definition by state name
 */
export function getStateDefinition(state: SellerDecisionState): DecisionStateDefinition | undefined {
  return SELLER_DECISION_STATES.find((s) => s.state === state)
}

/**
 * Get all state definitions
 */
export function getAllStates(): DecisionStateDefinition[] {
  return SELLER_DECISION_STATES
}

/**
 * Get milestone states only
 */
export function getMilestoneStates(): DecisionStateDefinition[] {
  return SELLER_DECISION_STATES.filter((s) => s.isMilestone)
}

/**
 * Check if state allows override
 */
export function allowsOverride(state: SellerDecisionState): boolean {
  const def = getStateDefinition(state)
  return def?.allowsOverride || false
}

/**
 * Check if state allows reversal
 */
export function allowsReversal(state: SellerDecisionState): boolean {
  const def = getStateDefinition(state)
  return def?.allowsReversal || false
}

/**
 * Get required role for override
 */
export function getOverrideRequiredRole(state: SellerDecisionState): RequiredRole | undefined {
  const def = getStateDefinition(state)
  return def?.overrideRequiredRole
}

/**
 * Get system gates enabled by a state
 */
export function getEnabledSystemGates(state: SellerDecisionState): string[] {
  const def = getStateDefinition(state)
  return def?.enablesSystemGates || []
}

/**
 * Get SLA expectation hours for a state
 */
export function getSLAExpectation(state: SellerDecisionState): number | undefined {
  const def = getStateDefinition(state)
  return def?.slaExpectationHours
}

/**
 * Check if prerequisites are met for a state
 */
export function checkPrerequisites(
  state: SellerDecisionState,
  context: {
    cmaReady?: boolean
    netSheetReady?: boolean
    presentationAssembled?: boolean
    presentationVideoReady?: boolean
  }
): { met: boolean; missing: string[] } {
  const def = getStateDefinition(state)
  if (!def) {
    return { met: false, missing: ["Invalid state"] }
  }
  
  const missing: string[] = []
  const prereqs = def.prerequisites
  
  if (prereqs.cmaReady && !context.cmaReady) {
    missing.push("CMA not ready")
  }
  if (prereqs.netSheetReady && !context.netSheetReady) {
    missing.push("Net sheet not ready or expired")
  }
  if (prereqs.presentationAssembled && !context.presentationAssembled) {
    missing.push("Presentation not assembled")
  }
  if (prereqs.presentationVideoReady && !context.presentationVideoReady) {
    missing.push("Presentation video not ready")
  }
  
  return {
    met: missing.length === 0,
    missing,
  }
}
