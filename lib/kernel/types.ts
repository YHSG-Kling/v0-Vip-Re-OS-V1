// lib/kernel/types.ts
// LAYER 0 — canonical domain types for the entire platform.
// This file imports nothing. All other layers import from here.
// No default exports. All types are named exports with strict unions — no `string` in kernel params.

// ─── ENTITY TYPE ──────────────────────────────────────────────────────────────

export type EntityType =
  | "buyer"
  | "buyer_lifecycle"          // 13-state buyer journey → contacts.buyer_stage
  | "seller"
  | "listing"
  | "listing_stage_machine"    // listing lifecycle_stage column
  | "transaction"
  | "document"
  | "offer"
  | "tour"
  | "repair"
  | "financial"
  | "lead"
  | "journey"
  | "showing"
  | "qr_scan"
  | "business_card"
  | "territory"
  | "contact"
  | "agent_onboarding_machine"

// ── Lead Lifecycle States (Layer 2, Track A) ──────────────────────────────
export type LeadLifecycleStage =
  | 'raw'            // Just created, no processing
  | 'unconsented'    // In pipeline, no digital consent
  | 'isa_qualifying' // AI ISA outreach active
  | 'consented'      // Digital opt-in received
  | 'assigned'       // Agent assigned, contact auto-created
  | 'appointment'    // ISA booked appointment
  | 'representation' // Contract signed — all ISA blocked

// ── Contact Pipeline Stages (Layer 2, Track B) ───────────────────────────
export type ContactPipelineStage =
  | 'captured'           // Contact row created/merged
  | 'dedup_merged'       // Merged into existing contact
  | 'enrichment_queued'  // Queued in lead_enrichment_queue
  | 'enriched'           // PeopleData enrichment complete
  | 'scored'             // Scored into lead_score_history

// ─── BUYER LIFECYCLE STAGES ───────────────────────────────────────────────────

export type BuyerStage =
  | "NEW"
  | "FINANCIALLY_VERIFIED"
  | "SEARCHING"
  | "OFFER_ELIGIBLE"
  | "OFFER_SUBMITTED"
  | "UNDER_CONTRACT"
  | "CLOSED"
  | "DISENGAGED"

// ─── SELLER LIFECYCLE STAGES ──────────────────────────────────────────────────

export type SellerStage =
  | "NEW"
  | "EQUITY_CONFIRMED"
  | "DECISION_PENDING"
  | "ACTIVE_LISTING"
  | "OFFER_RECEIVED"
  | "UNDER_CONTRACT"
  | "CLOSED"
  | "DISENGAGED"

// ─── JOURNEY ──────────────────────────────────────────────────────────────────

export type JourneyType = "buyer" | "seller" | "dual"

export type JourneyPhase = "pre" | "active" | "post"

// ─── MESSAGE CHANNEL ──────────────────────────────────────────────────────────
// social: WhatsApp lives in metadata.subchannel
// phone:  Voicemail lives in metadata.subchannel
// direct_mail: system provider only — no per-user override

export type MessageType =
  | "email"
  | "sms"
  | "social"
  | "phone"
  | "in_app"
  | "ai"
  | "direct_mail"

// ─── PROVIDER TYPE ────────────────────────────────────────────────────────────
// Authoritative union of every resolvable provider type. Mirrors the tiers in
// lib/kernel/providers.ts. PER-TENANT types cascade (user→team→brokerage→
// superadmin→default); PLATFORM types are system-only (superadmin override or
// system default — no per-tenant overrides).

export type ProviderType =
  // Per-tenant (BYO via cascade)
  | "email"
  | "sms"
  | "social"
  | "phone"
  | "calendar"
  | "payment"
  | "esign"
  | "transaction"
  | "crm"
  | "accounting"
  | "idx"
  // Platform (system-only)
  | "ai"
  | "video"
  | "avatar"
  | "voice_clone"
  | "ai_voice"
  | "direct_mail"
  | "scraper"
  | "enrichment"

// ─── ACTOR ROLE ───────────────────────────────────────────────────────────────

export type ActorRole =
  | "superadmin"
  | "broker"
  | "admin"
  | "team_lead"
  | "agent"
  | "isa"
  | "tc"
  | "compliance_officer"
  | "vendor"
  | "lender"
  | "title_agent"
  | "contact"
  | "system"

// ─── PERSONA ──────────────────────────────────────────────────────────────────

export type Persona =
  | "first_time"
  | "relocated"
  | "luxury"
  | "fsbo"
  | "probate"
  | "upsize"
  | "downsize"
  | "military"
  | "divorce"
  | "senior"
  | "expired"
  | "foreclosure"
  | "other"

// ─── EDUCATION FORMAT ─────────────────────────────────────────────────────────

export type EducationFormat = "video" | "guide" | "checklist" | "quiz"

// ─── USER TIER ────────────────────────────────────────────────────────────────

export type UserTier = "solo_agent" | "team" | "brokerage" | "multi_location"

// ─── KERNEL CONTACT SHAPE ─────────────────────────────────────────────────────
// Only the fields kernel actually uses. Prevents silent mismatch at call sites.

export interface KernelContact {
  // Identity
  id: string
  first_name: string
  last_name: string
  email?: string
  phone?: string

  // Classification
  contact_type: "buyer" | "seller" | "both" | "investor" | "vendor" | "lender"
  persona?: Persona

  // State & Lifecycle
  // buyer_stage lives on the contact (buyers have no listing entity). The seller
  // journey is tracked on the listing (listings.lifecycle_stage) — contacts has
  // no seller_stage column, so it's intentionally not modeled here.
  buyer_stage?: BuyerStage
  lifecycle_state?: string
  status?: string

  // TCPA Compliance
  tcpa_consent: boolean
  tcpa_consent_date?: string
  tcpa_marked_by?: string
  tcpa_marked_at?: string

  // ISA Re-engagement Override
  isa_reengage_allowed: boolean
  isa_reengage_set_at?: string
  isa_reengage_marked_by?: string

  // Do Not Contact / Stop Outreach
  dnc_status: boolean           // Hard DNC — do not contact at all
  stop_comment?: string         // Human-readable reason
  stop_contact_date?: string    // When stop was requested
  stop_contact_by?: string      // Who marked the stop

  // Context
  brokerage_id?: string
  team_id?: string
  agent_id?: string
}

// ─── CONTACT SUB-INTERFACES ───────────────────────────────────────────────────

/** ISA re-engagement override — explicit interface for compliance checks */
export interface ContactISAOverride {
  isa_reengage_allowed: boolean
  isa_reengage_set_at?: string
  isa_reengage_marked_by?: string
}

/** TCPA compliance tracking */
export interface ContactTCPAInfo {
  tcpa_consent: boolean
  tcpa_consent_date?: string
  tcpa_marked_by?: string
  tcpa_marked_at?: string
}

/** Contact stop / DNC status */
export interface ContactStopStatus {
  dnc_status: boolean
  stop_comment?: string
  stop_contact_date?: string
  stop_contact_by?: string
}

// ─── ACTOR CONTEXT ────────────────────────────────────────────────────────────

/** Who is performing the action — used in compliance checks, feature access, overrides */
export interface ActorContext {
  userId: string
  role: ActorRole       // STRICT: ActorRole union, not string
  brokerageId: string
  teamId?: string
}

// ─── KERNEL FUNCTION PARAMETERS ───────────────────────────────────────────────

/** transitionLifecycle params — all types strict, no bare string for union fields */
export interface TransitionLifecycleParams {
  brokerageId: string
  entityType: EntityType    // STRICT: EntityType union
  entityId: string
  fromState: string         // State values vary per entity (BuyerStage, SellerStage, etc.)
  toState: string
  actorUserId: string | null  // null for system/webhook/cron transitions (no user session)
  actorRole?: ActorRole     // Optional — system-triggered transitions may not have a role
  eventType: string         // e.g. 'buyer.financial_verification_submitted'
  metadata?: Record<string, any>
}

/** evaluateOutbound params — all types strict */
export interface EvaluateOutboundParams {
  actorContext: ActorContext
  journeyType: JourneyType  // STRICT: JourneyType union
  persona: Persona          // STRICT: Persona union
  messageType: MessageType  // STRICT: MessageType union (includes direct_mail as special case)
  content: string
  /** Specific contact being messaged. Omit for broadcast campaigns — DNC/TCPA gates are skipped. */
  contact?: KernelContact
}

// ─── RESULT TYPES ─────────────────────────────────────────────────────────────

/** Compliance gate evaluation result */
export interface ComplianceResult {
  allowed: boolean
  correctedContent?: string
  violations: string[]
  blockedReason?: string
  /** compliance_events.id of the row this evaluation just logged. Lets
   *  callers stamp the audit id on dependent rows (e.g. preset.compliance_event_id)
   *  without a follow-up race-prone re-query. */
  complianceEventId?: string
}

/** Feature access check result */
export interface FeatureAccessCheck {
  allowed: boolean
  reason?: string
  trial?: boolean
  trial_expires_at?: string
  usage?: {
    current: number
    limit: number
    remaining: number
  }
  disabled?: boolean
  disabled_reason?: string
}

// ─── PROVIDER TYPES ───────────────────────────────────────────────────────────

/** Provider choice result — resolved from hierarchy */
export interface ProviderChoice {
  providerType: ProviderType
  providerKey: string           // e.g. 'sendgrid', 'twilio', 'dotloop'
  config: Record<string, any>
  scope?: string                // 'user' | 'team' | 'brokerage' | 'superadmin_personal' | 'system_default'
}

// ─── EDUCATION & PORTAL ───────────────────────────────────────────────────────

/** Delivery configuration resolved from age-segment matrix */
export interface EducationDeliveryConfig {
  preferredChannel: MessageType
  format: EducationFormat
  readability: "simple" | "standard" | "detailed"
  estimatedMinutes: number
}

/** A single education lesson */
export interface EducationLesson {
  key: string
  title: string
  format: EducationFormat
  duration: number
  contentUrl?: string
}

/** Education plan segment — one per JourneyPhase */
export interface EducationPlan {
  segment: JourneyPhase
  completed: boolean
  lessons: EducationLesson[]
}

/** A single portal milestone derived from lifecycle_events */
export interface PortalMilestone {
  eventType: string
  description: string
  date: string
  metadata: Record<string, any>
}

// ─── DATABASE ROW TYPES ───────────────────────────────────────────────────────

export interface NotificationRuleRow {
  id: string
  brokerage_id: string
  trigger_event: string
  channel: 'email' | 'sms' | 'in_app' | 'push'
  template_key?: string | null
  recipient_role?: string | null
  delay_minutes?: number | null
  is_active: boolean
  created_at: string
  updated_at?: string | null
}

export interface GlobalSettingsRow {
  id: string
  brokerage_id?: string | null
  setting_key: string
  setting_value: string | null
  is_encrypted?: boolean
  created_at: string
  updated_at?: string | null
}

export interface AutomationErrorRow {
  id: string
  brokerage_id?: string | null
  workflow_id?: string | null
  error_type: string
  error_message: string
  stack_trace?: string | null
  entity_type?: string | null
  entity_id?: string | null
  retry_count: number
  resolved: boolean
  created_at: string
}

export interface CalendarSyncLogRow {
  id: string
  brokerage_id?: string | null
  user_id: string
  provider: string
  sync_type: 'push' | 'pull' | 'full'
  status: 'success' | 'error' | 'partial'
  records_synced?: number | null
  error_message?: string | null
  synced_at: string
}

export interface OnboardingStepRow {
  id: string
  user_id: string
  brokerage_id?: string | null
  step_key: string
  status: 'pending' | 'in_progress' | 'completed' | 'skipped'
  completed_at?: string | null
  metadata?: Record<string, any> | null
  created_at: string
}
