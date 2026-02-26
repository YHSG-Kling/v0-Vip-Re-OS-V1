/**
 * System 5.2: Listing Lifecycle Core - Lifecycle Definitions
 * 
 * Defines the canonical 31-stage listing lifecycle with:
 * - Allowed previous stages (for validation)
 * - Required readiness checks
 * - Required roles (for authority)
 * - System gating signals
 * 
 * This is GOVERNANCE ONLY - no execution logic, no UI
 */

export type ListingStage =
  | "LEAD"
  | "LEAD_ASSIGNED"
  | "AGENT_CONSULTATION"
  | "APPOINTMENT_SET"
  | "CMA_GENERATION"
  | "LISTING_PRESENTATION_CREATED"
  | "PRESENTATION_VIDEO_GENERATED"
  | "PRESENTATION_DRIP_PREP"
  | "SELLER_DECISION"
  | "LISTING_AGREEMENT_INITIATED"
  | "LISTING_AGREEMENT_SIGNED"
  | "MLS_DATE_CONFIRMED"
  | "COMING_SOON_PREP"
  | "REPAIRS_IN_PROGRESS"
  | "COMING_SOON_ACTIVE"
  | "MEDIA_CAPTURE"
  | "MEDIA_APPROVED"
  | "MLS_READY"
  | "OPEN_HOUSE_MARKETING"
  | "MLS_ACTIVE"
  | "OPEN_HOUSE_EVENT"
  | "SHOWINGS_ACTIVE"
  | "OFFERS_RECEIVED"
  | "NEGOTIATION"
  | "UNDER_CONTRACT"
  | "INSPECTION"
  | "APPRAISAL"
  | "FINANCING"
  | "CLOSING_PREP"
  | "CLOSED"
  | "LIFETIME_CUSTOMER"

export type ReadinessCheckType =
  | "documents_verified"
  | "dotloop_signatures"
  | "media_approved"
  | "repairs_completed"
  | "mls_data_complete"
  | "showings_enabled"
  | "offer_exists"
  | "contract_signed"
  | "inspection_completed"
  | "appraisal_completed"
  | "financing_approved"
  | "closing_docs_ready"

export type RequiredRole = "agent" | "team_lead" | "broker" | "admin"

export interface StageDefinition {
  stage: ListingStage
  label: string
  description: string
  
  // Allowed previous stages (empty = can be first stage)
  allowedFrom: ListingStage[]
  
  // Required readiness checks
  readinessChecks: ReadinessCheckType[]
  
  // Required roles (any of these can advance)
  requiredRoles: RequiredRole[]
  
  // System gating signals this stage enables
  enablesSystemGates?: string[]
  
  // Is this a milestone stage? (for reporting)
  isMilestone: boolean
}

/**
 * Canonical Listing Lifecycle Definition
 * 31 stages from Lead → Lifetime Customer
 */
export const LISTING_LIFECYCLE_STAGES: StageDefinition[] = [
  {
    stage: "LEAD",
    label: "Lead",
    description: "Initial lead captured, not yet assigned",
    allowedFrom: [],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    stage: "LEAD_ASSIGNED",
    label: "Lead Assigned",
    description: "Lead assigned to an agent",
    allowedFrom: ["LEAD"],
    readinessChecks: [],
    requiredRoles: ["team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "AGENT_CONSULTATION",
    label: "Agent Consultation",
    description: "Agent is consulting with potential seller",
    allowedFrom: ["LEAD_ASSIGNED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "APPOINTMENT_SET",
    label: "Appointment Set",
    description: "Listing presentation appointment scheduled",
    allowedFrom: ["AGENT_CONSULTATION"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    stage: "CMA_GENERATION",
    label: "CMA Generation",
    description: "Comparative Market Analysis being prepared",
    allowedFrom: ["APPOINTMENT_SET"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "LISTING_PRESENTATION_CREATED",
    label: "Listing Presentation Created",
    description: "Listing presentation materials prepared",
    allowedFrom: ["CMA_GENERATION"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "PRESENTATION_VIDEO_GENERATED",
    label: "Presentation Video Generated",
    description: "Custom presentation video created",
    allowedFrom: ["LISTING_PRESENTATION_CREATED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "PRESENTATION_DRIP_PREP",
    label: "Presentation Drip Prep",
    description: "Follow-up sequence prepared",
    allowedFrom: ["PRESENTATION_VIDEO_GENERATED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "SELLER_DECISION",
    label: "Seller Decision",
    description: "Awaiting seller decision to list",
    allowedFrom: ["PRESENTATION_DRIP_PREP"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    stage: "LISTING_AGREEMENT_INITIATED",
    label: "Listing Agreement Initiated",
    description: "Listing agreement process started",
    allowedFrom: ["SELLER_DECISION"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "LISTING_AGREEMENT_SIGNED",
    label: "Listing Agreement Signed",
    description: "Listing agreement fully executed",
    allowedFrom: ["LISTING_AGREEMENT_INITIATED"],
    readinessChecks: ["dotloop_signatures", "documents_verified"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    stage: "MLS_DATE_CONFIRMED",
    label: "MLS Date Confirmed",
    description: "MLS go-live date confirmed with seller",
    allowedFrom: ["LISTING_AGREEMENT_SIGNED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "COMING_SOON_PREP",
    label: "Coming Soon Prep",
    description: "Preparing for coming soon marketing",
    allowedFrom: ["MLS_DATE_CONFIRMED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "REPAIRS_IN_PROGRESS",
    label: "Repairs In Progress",
    description: "Pre-listing repairs being completed",
    allowedFrom: ["COMING_SOON_PREP"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "COMING_SOON_ACTIVE",
    label: "Coming Soon Active",
    description: "Coming soon marketing active",
    allowedFrom: ["REPAIRS_IN_PROGRESS"],
    readinessChecks: ["repairs_completed"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["marketing_execution"],
    isMilestone: true,
  },
  {
    stage: "MEDIA_CAPTURE",
    label: "Media Capture",
    description: "Professional photos/video being captured",
    allowedFrom: ["COMING_SOON_ACTIVE"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "MEDIA_APPROVED",
    label: "Media Approved",
    description: "Photos/video approved by agent and seller",
    allowedFrom: ["MEDIA_CAPTURE"],
    readinessChecks: ["media_approved"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "MLS_READY",
    label: "MLS Ready",
    description: "Ready to go live on MLS",
    allowedFrom: ["MEDIA_APPROVED"],
    readinessChecks: ["mls_data_complete", "media_approved"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["flyers_packets", "listing_marketing"],
    isMilestone: true,
  },
  {
    stage: "OPEN_HOUSE_MARKETING",
    label: "Open House Marketing",
    description: "Open house marketing materials prepared",
    allowedFrom: ["MLS_READY"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["open_house_system"],
    isMilestone: false,
  },
  {
    stage: "MLS_ACTIVE",
    label: "MLS Active",
    description: "Live on MLS",
    allowedFrom: ["OPEN_HOUSE_MARKETING"],
    readinessChecks: ["mls_data_complete"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    stage: "OPEN_HOUSE_EVENT",
    label: "Open House Event",
    description: "Open house event scheduled/completed",
    allowedFrom: ["MLS_ACTIVE"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "SHOWINGS_ACTIVE",
    label: "Showings Active",
    description: "Showing management active",
    allowedFrom: ["OPEN_HOUSE_EVENT", "MLS_ACTIVE"],
    readinessChecks: ["showings_enabled"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["seller_showings"],
    isMilestone: false,
  },
  {
    stage: "OFFERS_RECEIVED",
    label: "Offers Received",
    description: "One or more offers received",
    allowedFrom: ["SHOWINGS_ACTIVE"],
    readinessChecks: ["offer_exists"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["offers_system"],
    isMilestone: true,
  },
  {
    stage: "NEGOTIATION",
    label: "Negotiation",
    description: "Negotiating offer terms",
    allowedFrom: ["OFFERS_RECEIVED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "UNDER_CONTRACT",
    label: "Under Contract",
    description: "Contract executed, pending contingencies",
    allowedFrom: ["NEGOTIATION"],
    readinessChecks: ["contract_signed"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["transactions_system"],
    isMilestone: true,
  },
  {
    stage: "INSPECTION",
    label: "Inspection",
    description: "Buyer inspection period",
    allowedFrom: ["UNDER_CONTRACT"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "APPRAISAL",
    label: "Appraisal",
    description: "Property appraisal in progress",
    allowedFrom: ["INSPECTION"],
    readinessChecks: ["inspection_completed"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "FINANCING",
    label: "Financing",
    description: "Buyer financing approval in progress",
    allowedFrom: ["APPRAISAL"],
    readinessChecks: ["appraisal_completed"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "CLOSING_PREP",
    label: "Closing Prep",
    description: "Preparing for closing",
    allowedFrom: ["FINANCING"],
    readinessChecks: ["financing_approved"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["closing_prep_system"],
    isMilestone: false,
  },
  {
    stage: "CLOSED",
    label: "Closed",
    description: "Transaction closed successfully",
    allowedFrom: ["CLOSING_PREP"],
    readinessChecks: ["closing_docs_ready"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: true,
  },
  {
    stage: "LIFETIME_CUSTOMER",
    label: "Lifetime Customer",
    description: "Enrolled in lifetime customer retention program",
    allowedFrom: ["CLOSED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["retention_system"],
    isMilestone: true,
  },
]

/**
 * Get stage definition by stage name
 */
export function getStageDefinition(stage: ListingStage): StageDefinition | undefined {
  return LISTING_LIFECYCLE_STAGES.find((s) => s.stage === stage)
}

/**
 * Get all stage definitions
 */
export function getAllStages(): StageDefinition[] {
  return LISTING_LIFECYCLE_STAGES
}

/**
 * Get stage index (position in lifecycle)
 */
export function getStageIndex(stage: ListingStage): number {
  return LISTING_LIFECYCLE_STAGES.findIndex((s) => s.stage === stage)
}

/**
 * Check if stage A comes before stage B in the lifecycle
 */
export function isBeforeStage(stageA: ListingStage, stageB: ListingStage): boolean {
  return getStageIndex(stageA) < getStageIndex(stageB)
}

/**
 * Get milestone stages only
 */
export function getMilestoneStages(): StageDefinition[] {
  return LISTING_LIFECYCLE_STAGES.filter((s) => s.isMilestone)
}

/**
 * Get system gates enabled at or before a given stage
 */
export function getEnabledSystemGates(currentStage: ListingStage): string[] {
  const currentIndex = getStageIndex(currentStage)
  const gates: string[] = []
  
  for (let i = 0; i <= currentIndex; i++) {
    const stage = LISTING_LIFECYCLE_STAGES[i]
    if (stage.enablesSystemGates) {
      gates.push(...stage.enablesSystemGates)
    }
  }
  
  return [...new Set(gates)] // Remove duplicates
}

/**
 * Check if a system gate is enabled for a given stage
 */
export function isSystemGateEnabled(currentStage: ListingStage, gateName: string): boolean {
  const enabledGates = getEnabledSystemGates(currentStage)
  return enabledGates.includes(gateName)
}
