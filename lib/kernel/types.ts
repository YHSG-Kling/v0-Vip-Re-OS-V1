// lib/kernel/types.ts
// LAYER 0 — canonical domain types for the entire platform.
// All other layers import from here; nothing in this file imports from the rest of the app.
// No default exports.

// ─── PERSONAS ─────────────────────────────────────────────────────────────────

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

// ─── MESSAGE CHANNEL ──────────────────────────────────────────────────────────
// social: WhatsApp lives in metadata.subchannel
// phone:  Voicemail lives in metadata.subchannel

export type MessageType =
  | "email"
  | "sms"
  | "social"
  | "phone"
  | "in_app"
  | "ai"
  | "direct_mail"

// ─── PROVIDER ─────────────────────────────────────────────────────────────────
// Note: direct_mail and video are system providers only — no per-user overrides.

export type ProviderType =
  | "email"
  | "sms"
  | "social"
  | "phone"
  | "calendar"
  | "payment"
  | "esign"
  | "transaction"
  | "ai"

// ─── EDUCATION FORMAT ─────────────────────────────────────────────────────────

export type EducationFormat = "video" | "guide" | "checklist" | "quiz"

// ─── ACTOR ROLE ───────────────────────────────────────────────────────────────

export type ActorRole =
  | "agent"
  | "broker"
  | "admin"
  | "tc"
  | "compliance_officer"
  | "vendor"
  | "lender"
  | "title_agent"
  | "contact"
  | "system"
  | "isa"
  | "super_admin"

// ─── ENTITY TYPE ──────────────────────────────────────────────────────────────

export type EntityType =
  | "buyer"
  | "seller"
  | "listing"
  | "transaction"
  | "document"
  | "offer"
  | "tour"
  | "repair"
  | "financial"

// ─── JOURNEY ──────────────────────────────────────────────────────────────────

export type JourneyPhase = "pre" | "active"

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

// ─── COMPOUND PARAMETER INTERFACES ───────────────────────────────────────────

export interface TransitionLifecycleParams {
  brokerageId: string
  entityType: string
  entityId: string
  fromState: string
  toState: string
  actorUserId: string
  eventType: string
  metadata?: Record<string, any>
}

export interface EvaluateOutboundParams {
  actorContext: {
    userId: string
    role: string
    brokerageId: string
    teamId?: string
  }
  journeyType: "buyer" | "seller"
  persona: Persona
  messageType: MessageType
  content: string
  contact: any
}

export interface ComplianceResult {
  allowed: boolean
  correctedContent?: string
  violations: string[]
  blockedReason?: string
}
