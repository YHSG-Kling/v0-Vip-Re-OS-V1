/**
 * System 5.1C: Buyer Lifecycle Governance Core - Lifecycle Definitions
 * 
 * Defines the canonical 13-state buyer lifecycle with:
 * - Allowed previous states
 * - Financial verification requirements
 * - Required roles (for authority)
 * - System gating signals
 * 
 * This is GOVERNANCE ONLY - no execution logic, no UI, no lender integrations
 */

export type BuyerState =
  | "BUYER_CONTACT_CREATED"
  | "BUYER_FINANCIALLY_VERIFIED"
  | "BUYER_SEARCH_CONFIGURED"
  | "BUYER_SEARCHING"
  | "BUYER_TOUR_ELIGIBLE"
  | "BUYER_TOURING"
  | "BUYER_OFFER_ELIGIBLE"
  | "BUYER_OFFER_SUBMITTED"
  | "BUYER_UNDER_CONTRACT"
  | "BUYER_ON_HOLD"
  | "BUYER_DISENGAGED"
  | "BUYER_CLOSED"
  | "BUYER_LIFETIME"

export type RequiredRole = "agent" | "team_lead" | "broker" | "admin"

export interface StateDefinition {
  state: BuyerState
  label: string
  description: string
  
  // Allowed previous states (empty = can be first state)
  allowedFrom: BuyerState[]
  
  // Requires financial verification to enter?
  requiresFinancialVerification: boolean
  
  // Required roles (any of these can advance)
  requiredRoles: RequiredRole[]
  
  // System gating signals this state enables
  enablesSystemGates?: string[]
  
  // Is this a milestone state? (for reporting)
  isMilestone: boolean
  
  // Is this state frozen? (read-only after entry)
  isFrozen?: boolean
}

/**
 * Canonical Buyer Lifecycle Definition
 * 13 states from Contact Created → Lifetime Customer
 */
export const BUYER_LIFECYCLE_STATES: StateDefinition[] = [
  {
    state: "BUYER_CONTACT_CREATED",
    label: "Contact Created",
    description: "Buyer contact record created, not yet qualified",
    allowedFrom: [],
    requiresFinancialVerification: false,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    state: "BUYER_FINANCIALLY_VERIFIED",
    label: "Financially Verified",
    description: "Buyer financial capacity verified (pre-approval, proof-of-funds, or lender intro)",
    allowedFrom: ["BUYER_CONTACT_CREATED"],
    requiresFinancialVerification: false, // This IS the verification state
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["property_search", "tour_eligibility", "offer_eligibility"],
    isMilestone: true,
  },
  {
    state: "BUYER_SEARCH_CONFIGURED",
    label: "Search Configured",
    description: "Search criteria and preferences configured",
    allowedFrom: ["BUYER_FINANCIALLY_VERIFIED"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    state: "BUYER_SEARCHING",
    label: "Actively Searching",
    description: "Buyer actively searching for properties",
    allowedFrom: ["BUYER_SEARCH_CONFIGURED"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["property_search"],
    isMilestone: true,
  },
  {
    state: "BUYER_TOUR_ELIGIBLE",
    label: "Tour Eligible",
    description: "Buyer eligible to schedule property tours",
    allowedFrom: ["BUYER_SEARCHING"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["tour_scheduling"],
    isMilestone: false,
  },
  {
    state: "BUYER_TOURING",
    label: "Touring Properties",
    description: "Buyer actively viewing properties",
    allowedFrom: ["BUYER_TOUR_ELIGIBLE"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["showing_management"],
    isMilestone: true,
  },
  {
    state: "BUYER_OFFER_ELIGIBLE",
    label: "Offer Eligible",
    description: "Buyer ready to submit offers",
    allowedFrom: ["BUYER_TOURING"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["offer_creation"],
    isMilestone: false,
  },
  {
    state: "BUYER_OFFER_SUBMITTED",
    label: "Offer Submitted",
    description: "Buyer has submitted one or more offers",
    allowedFrom: ["BUYER_OFFER_ELIGIBLE"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["offer_tracking"],
    isMilestone: true,
  },
  {
    state: "BUYER_UNDER_CONTRACT",
    label: "Under Contract",
    description: "Buyer has accepted offer, under contract (FROZEN STATE)",
    allowedFrom: ["BUYER_OFFER_SUBMITTED"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["transaction_management"],
    isMilestone: true,
    isFrozen: true, // Lifecycle frozen - transaction system takes over
  },
  {
    state: "BUYER_ON_HOLD",
    label: "On Hold",
    description: "Buyer paused search temporarily",
    allowedFrom: [
      "BUYER_FINANCIALLY_VERIFIED",
      "BUYER_SEARCH_CONFIGURED",
      "BUYER_SEARCHING",
      "BUYER_TOUR_ELIGIBLE",
      "BUYER_TOURING",
      "BUYER_OFFER_ELIGIBLE",
      "BUYER_OFFER_SUBMITTED",
    ],
    requiresFinancialVerification: false,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    state: "BUYER_DISENGAGED",
    label: "Disengaged",
    description: "Buyer disengaged, no longer actively searching",
    allowedFrom: [
      "BUYER_FINANCIALLY_VERIFIED",
      "BUYER_SEARCH_CONFIGURED",
      "BUYER_SEARCHING",
      "BUYER_TOUR_ELIGIBLE",
      "BUYER_TOURING",
      "BUYER_OFFER_ELIGIBLE",
      "BUYER_OFFER_SUBMITTED",
      "BUYER_ON_HOLD",
    ],
    requiresFinancialVerification: false,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    state: "BUYER_CLOSED",
    label: "Closed",
    description: "Transaction closed successfully",
    allowedFrom: ["BUYER_UNDER_CONTRACT"],
    requiresFinancialVerification: true,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    state: "BUYER_LIFETIME",
    label: "Lifetime Customer",
    description: "Enrolled in lifetime customer retention program",
    allowedFrom: ["BUYER_CLOSED"],
    requiresFinancialVerification: false,
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["retention_system"],
    isMilestone: true,
  },
]

/**
 * Get state definition by state name
 */
export function getStateDefinition(state: BuyerState): StateDefinition | undefined {
  return BUYER_LIFECYCLE_STATES.find((s) => s.state === state)
}

/**
 * Get all state definitions
 */
export function getAllStates(): StateDefinition[] {
  return BUYER_LIFECYCLE_STATES
}

/**
 * Get state index (position in lifecycle)
 */
export function getStateIndex(state: BuyerState): number {
  return BUYER_LIFECYCLE_STATES.findIndex((s) => s.state === state)
}

/**
 * Check if state is frozen (read-only after entry)
 */
export function isStateFrozen(state: BuyerState): boolean {
  const def = getStateDefinition(state)
  return def?.isFrozen || false
}

/**
 * Get milestone states only
 */
export function getMilestoneStates(): StateDefinition[] {
  return BUYER_LIFECYCLE_STATES.filter((s) => s.isMilestone)
}

/**
 * Get system gates enabled at or before a given state
 */
export function getEnabledSystemGates(currentState: BuyerState): string[] {
  const currentIndex = getStateIndex(currentState)
  const gates: string[] = []
  
  for (let i = 0; i <= currentIndex; i++) {
    const state = BUYER_LIFECYCLE_STATES[i]
    if (state.enablesSystemGates) {
      gates.push(...state.enablesSystemGates)
    }
  }
  
  return [...new Set(gates)] // Remove duplicates
}

/**
 * Check if a system gate is enabled for a given state
 */
export function isSystemGateEnabled(currentState: BuyerState, gateName: string): boolean {
  const enabledGates = getEnabledSystemGates(currentState)
  return enabledGates.includes(gateName)
}

/**
 * Check if financial verification is required for a state
 */
export function requiresFinancialVerification(state: BuyerState): boolean {
  const def = getStateDefinition(state)
  return def?.requiresFinancialVerification || false
}
