// lib/kernel/events.ts
//
// CANONICAL kernel event registry.
// All lifecycle, compliance, and activity systems emit one of these events ONLY.
//
// Rules:
// - This enum IS the source of truth. No system may emit a string not listed here.
// - Enum values match trigger_event in the notification_rules table exactly.
// - Every lifecycle state transition maps to exactly one KernelEvent.
// - Compliance violations → COMPLIANCE_VIOLATION
// - Activities → one of TASK_*, DOCUMENT_*, SHOWING_*, MESSAGE_*
// - Future events are added here FIRST, then cascaded downstream.
// - No string concatenation. Enum values are THE reference.
//
// TypeScript strict mode — export only the enum.

export enum KernelEvent {
  // ── Contact / Lead ────────────────────────────────────────────────────────
  CONTACT_CREATED           = 'contact_created',

  // ── Buyer Journey ─────────────────────────────────────────────────────────
  BUYER_VERIFIED            = 'buyer_verified',
  TOUR_ELIGIBLE             = 'tour_eligible',
  TOUR_SCHEDULED            = 'tour_scheduled',
  OFFER_ELIGIBLE            = 'offer_eligible',
  OFFER_SUBMITTED           = 'offer_submitted',

  // ── Seller Journey ────────────────────────────────────────────────────────
  DECISION_PENDING          = 'decision_pending',
  PRICE_DETERMINED          = 'price_determined',
  LISTING_PUBLISHED         = 'listing_published',

  // ── Offer / Contract ──────────────────────────────────────────────────────
  OFFER_RECEIVED            = 'offer_received',
  CONTRACT_SIGNED           = 'contract_signed',

  // ── Transaction States ────────────────────────────────────────────────────
  DEAL_ON_HOLD              = 'deal_on_hold',
  BUYER_DISENGAGED          = 'buyer_disengaged',
  DEAL_CLOSED               = 'deal_closed',
  LIFETIME_CUSTOMER         = 'lifetime_customer',

  // ── Critical Milestones (SLA tracking) ────────────────────────────────────
  INSPECTION_DUE            = 'inspection_due',
  FINANCING_DUE             = 'financing_due',
  APPRAISAL_DUE             = 'appraisal_due',
  WALKTHROUGH_DUE           = 'walkthrough_due',
  CD_DUE                    = 'cd_due',
  CD_RECEIVED               = 'cd_received',
  CLOSING_SCHEDULED         = 'closing_scheduled',

  // ── Activities ────────────────────────────────────────────────────────────
  TASK_ASSIGNED             = 'task_assigned',
  TASK_DUE                  = 'task_due',
  TASK_OVERDUE              = 'task_overdue',
  TASK_COMPLETED            = 'task_completed',
  DOCUMENT_REQUESTED        = 'document_requested',
  DOCUMENT_RECEIVED         = 'document_received',
  SHOWING_SCHEDULED         = 'showing_scheduled',
  SHOWING_COMPLETED         = 'showing_completed',

  // ── Communications ────────────────────────────────────────────────────────
  MESSAGE_FROM_CONTACT      = 'message_from_contact',
  MESSAGE_NEEDS_RESPONSE    = 'message_needs_response',

  // ── Compliance ────────────────────────────────────────────────────────────
  COMPLIANCE_VIOLATION      = 'compliance_violation',
  AUTHORITY_BLOCKED         = 'authority_blocked',
}
