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
  | "SELLER_DECLINED"
  | "LISTING_CANCELLED"
  | "LISTING_EXPIRED"

export type ReadinessCheckType =
  | "documents_verified"
  | "provider_signatures"
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
    // "LEAD" merged in on the 2026-09-06 chronology measurement: the engine's
    // bookAppointment walks LEAD → APPOINTMENT_SET directly (a seller who books
    // from the intake form has had no consultation stage), and the kernel write
    // does not check this list, so the table forbade an edge the process took
    // every day. Same §6 rule as the pre-listing block below.
    allowedFrom: ["AGENT_CONSULTATION", "LEAD"],
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
  // ── THE PRE-LISTING CHRONOLOGY, ONE SPELLING (§6) ─────────────────────────
  //
  // Owner, 2026-09-06: "coming soon prep doesn't jump to active mls listing.
  // research this and get the business process chronological correct order."
  //
  // MEASURED before this edit: this table and the execution engine
  // (app/actions/seller-listing/execution-engine.ts) declared TWO different
  // orders for the same weeks of a listing's life. The table said
  //   prep → repairs → coming-soon ACTIVE → media capture → media approved
  //   → MLS ready → open-house marketing → MLS active
  // while the engine — the code that actually moves listings — walks
  //   signed → repairs → prep ⇄ (media capture → media approved) → coming-soon
  //   ACTIVE → MLS ready → MLS active (activateMLS, behind the compliance gate).
  // The kernel write (lib/kernel/lifecycle.ts::transitionLifecycle) does not
  // check allowedFrom, so every engine hop the table forbade succeeded silently,
  // and the validator / conformance checker / compliance loop — which DO read
  // this table — judged the live process against an order nobody ran.
  //
  // The engine's order is the business-correct one and is the SURVIVOR: the
  // listing is prepared (repairs, professional media) BEFORE it is announced as
  // coming soon — an MLS "Coming Soon" status carries the photos, and showings
  // are not permitted in it — then it goes live on its confirmed MLS date. So
  // COMING_SOON_PREP is the pre-listing hub (repairs and media loop through
  // it), COMING_SOON_ACTIVE is the public announcement, MLS_READY is the go-live
  // checkpoint, and MLS_ACTIVE is the live listing. Coming-soon prep never
  // jumps to MLS_ACTIVE: that stage is entered only from MLS_READY (activateMLS,
  // the gated door) or OPEN_HOUSE_MARKETING, and test:listing-compliance-loop
  // proves the loop's window ends at COMING_SOON_PREP.
  //
  // MLS_DATE_CONFIRMED stays between the signed agreement and prep: the
  // compliance loop records the MLS start date there and enters prep through
  // the gate. Predecessors below are the UNION of the two orders where the
  // engine already walks the edge; nothing the table allowed is removed.
  {
    stage: "COMING_SOON_PREP",
    label: "Coming Soon Prep",
    description: "Preparing for coming soon marketing",
    allowedFrom: ["MLS_DATE_CONFIRMED", "REPAIRS_IN_PROGRESS", "MEDIA_APPROVED"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "REPAIRS_IN_PROGRESS",
    label: "Repairs In Progress",
    description: "Pre-listing repairs being completed",
    allowedFrom: ["LISTING_AGREEMENT_SIGNED", "MLS_DATE_CONFIRMED", "COMING_SOON_PREP"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "COMING_SOON_ACTIVE",
    label: "Coming Soon Active",
    description: "Coming soon marketing active",
    allowedFrom: ["COMING_SOON_PREP", "REPAIRS_IN_PROGRESS"],
    readinessChecks: ["repairs_completed"],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    enablesSystemGates: ["marketing_execution"],
    isMilestone: true,
  },
  {
    stage: "MEDIA_CAPTURE",
    label: "Media Capture",
    description: "Professional photos/video being captured",
    allowedFrom: ["COMING_SOON_PREP", "COMING_SOON_ACTIVE"],
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
    allowedFrom: ["MEDIA_APPROVED", "COMING_SOON_ACTIVE"],
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
    allowedFrom: ["MLS_READY", "OPEN_HOUSE_MARKETING"],
    // `documents_verified` added on the owner's 2026-09-04 ruling: "same
    // compliance gate when a listing becomes an active listing."
    //
    // MLS_ACTIVE is a PUBLICLY-LIVE stage — lib/listings/listing-status-sync.ts
    // maps it to listings.status 'active' — and it declared only
    // mls_data_complete, so the generic stage-advance path
    // (lib/application/listing-lifecycle.ts::requireListingStageAdvance, reached
    // from the stage pipeline, the AI chat tool and updateListingStage) could
    // walk a listing live with no document, signature or initial check at all.
    // That was the bypass sitting beside the gate now enforced at activateMLS
    // and launchListing, and a gate with an open door next to it is not a gate.
    //
    // documents_verified now means presence AND execution — see
    // lib/listing-lifecycle/readiness-checker.ts::checkDocumentsVerified, which
    // runs the same findUnexecutedDocuments the two gates run.
    //
    // Obligation 1 (a compliance-passed, fully-executed listing agreement) is
    // not restated here because the stage graph already enforces it by
    // construction: every route through allowedFrom to MLS_ACTIVE passes through
    // LISTING_AGREEMENT_SIGNED, which is asserted in test:lifecycle-lib-defects
    // (d1.owner-ruling-holds-by-construction).
    readinessChecks: ["mls_data_complete", "documents_verified"],
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
    // "OFFERS_RECEIVED" merged in on the 2026-09-06 chronology measurement: an
    // offer accepted as written has no negotiation round, and the engine's
    // acceptOffer walks OFFERS_RECEIVED → UNDER_CONTRACT directly.
    allowedFrom: ["NEGOTIATION", "OFFERS_RECEIVED"],
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

  // ── Terminal exit stages (cannot be advanced from) ──────────────────────────
  {
    stage: "SELLER_DECLINED",
    label: "Seller Declined",
    description: "Seller decided not to list — listing process terminated",
    allowedFrom: ["SELLER_DECISION"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "LISTING_CANCELLED",
    label: "Listing Cancelled",
    description: "Active listing cancelled by agent, seller, or admin",
    allowedFrom: [],  // can originate from any active stage — enforced at engine layer
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
  {
    stage: "LISTING_EXPIRED",
    label: "Listing Expired",
    description: "Listing agreement period elapsed without a contract",
    allowedFrom: ["MLS_ACTIVE"],
    readinessChecks: [],
    requiredRoles: ["agent", "team_lead", "broker", "admin"],
    isMilestone: false,
  },
]

/**
 * THE ROLE VOCABULARY GAP, as a shared table.
 *
 * Every stage above declares `requiredRoles` from the four-value RequiredRole
 * vocabulary. The live database disagrees: `users_user_type_check` admits
 * fourteen values (admin, agent, broker, broker_owner, compliance_officer,
 * contact, isa, lender, superadmin, support, system, tc, team_lead, vendor).
 * Two of them are unambiguous supersets of an engine role and are translated;
 * the rest get `null` — a named refusal rather than authority nobody granted.
 *
 * This lives beside the stage table because it is the same governance decision,
 * and because a service that hand-rolls its own copy is a second vocabulary
 * that can drift from the stages it gates.
 */
export const USER_TYPE_TO_LIFECYCLE_ROLE: Record<string, RequiredRole> = {
  agent:        "agent",
  team_lead:    "team_lead",
  broker:       "broker",
  broker_owner: "broker",
  admin:        "admin",
  superadmin:   "admin",
}

/** Map a live `users.user_type` onto the stage engine's RequiredRole, or null. */
export function normalizeLifecycleRole(rawUserType: string | null | undefined): RequiredRole | null {
  const key = (rawUserType ?? "").trim().toLowerCase()
  if (!key) return null
  return USER_TYPE_TO_LIFECYCLE_ROLE[key] ?? null
}

/**
 * Get stage definition by stage name
 */
export function getStageDefinition(stage: ListingStage): StageDefinition | undefined {
  return LISTING_LIFECYCLE_STAGES.find((s) => s.stage === stage)
}

/**
 * Does this stage declare that it is entered from ANY active stage?
 *
 * DERIVED, never hand-listed: a stage with an EMPTY `allowedFrom` that is not
 * the first entry in LISTING_LIFECYCLE_STAGES is an exit stage the table
 * documents as reachable from anywhere (see LISTING_CANCELLED: "can originate
 * from any active stage — enforced at engine layer"). The first entry with an
 * empty allowedFrom is the lifecycle's ENTRY point (LEAD), which is a different
 * thing. Adding or reordering a stage updates this answer automatically.
 */
export function entersFromAnyStage(stage: ListingStage): boolean {
  const def = getStageDefinition(stage)
  if (!def) return false
  return def.allowedFrom.length === 0 && getStageIndex(stage) > 0
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
