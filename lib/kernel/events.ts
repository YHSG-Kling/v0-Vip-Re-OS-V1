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
  LISTING_AGREEMENT_SIGNED  = 'listing_agreement_signed',
  LISTING_STAGE_CHANGED                     = 'listing_stage_changed',
  COMING_SOON_SENT                          = 'coming_soon_sent',
  OPEN_HOUSE_MARKETING_STARTED              = 'open_house_marketing_started',
  OPEN_HOUSE_ATTENDEE_CAPTURED              = 'open_house_attendee_captured',
  SHOWING_REQUESTED                         = 'showing_requested',
  SHOWING_FEEDBACK_RECEIVED                 = 'showing_feedback_received',
  OFFER_UPLOADED                            = 'offer_uploaded',
  OFFER_AI_EXTRACTED                        = 'offer_ai_extracted',
  OFFER_COMPARISON_GENERATED                = 'offer_comparison_generated',
  OFFER_COUNTER_SENT                        = 'offer_counter_sent',
  OFFER_ACCEPTED                            = 'offer_accepted',
  OFFER_REJECTED                            = 'offer_rejected',
  OPEN_HOUSE_SCHEDULED                      = 'open_house_scheduled',
  CMA_GENERATED                             = 'cma_generated',
  PRICE_ALERT_TRIGGERED                     = 'price_alert_triggered',
  BRAND_COMPLIANCE_PASSED                   = 'brand_compliance_passed',
  BRAND_COMPLIANCE_FAILED                   = 'brand_compliance_failed',
  LISTING_MEDIA_SCHEDULED                   = 'listing_media_scheduled',
  LISTING_REPAIR_REQUIRED                   = 'listing_repair_required',
  LISTING_REPAIR_COMPLETED                  = 'listing_repair_completed',
  LISTING_REPAIR_FAILED                     = 'listing_repair_failed',
  LISTING_COMING_SOON_ASSETS_PREPARED       = 'listing_coming_soon_assets_prepared',
  LISTING_DRIP_COMPLETED                    = 'listing_drip_completed',
  LISTING_MLS_SUBMITTED_TO_ADMIN            = 'listing_mls_submitted_to_admin',
  LISTING_OPEN_HOUSE_COMPLETED              = 'listing_open_house_completed',
  LISTING_SHOWING_COMPLETED                 = 'listing_showing_completed',
  LISTING_PUBLISHED                         = 'listing_published',

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

  // ── Lead Acquisition (Track A — Lead-first) ───────────────────────────────
  LEAD_CAPTURED                  = 'lead_captured',
  LEAD_SCORED                    = 'lead_scored',
  RAW_LEAD_VIABILITY_PASSED      = 'raw_lead_viability_passed',
  RAW_LEAD_VIABILITY_FAILED      = 'raw_lead_viability_failed',

  // ── Contact Acquisition (Track B — Contact-first) ────────────────────────
  CONTACT_CAPTURED               = 'contact_captured',
  CONTACT_DEDUP_MERGED           = 'contact_dedup_merged',
  CONTACT_ENRICHMENT_QUEUED      = 'contact_enrichment_queued',
  CONTACT_ENRICHMENT_COMPLETED   = 'contact_enrichment_completed',
  CONTACT_ENRICHMENT_FAILED      = 'contact_enrichment_failed',
  CONTACT_SCORED                 = 'contact_scored',

  // ── ISA Pipeline ─────────────────────────────────────────────────────────
  ISA_QUALIFICATION_STARTED      = 'isa_qualification_started',
  ISA_OUTREACH_SENT              = 'isa_outreach_sent',
  ISA_REPLY_RECEIVED             = 'isa_reply_received',
  ISA_QUALIFIED_LEAD             = 'isa_qualified_lead',
  ISA_MAX_TOUCHES_REACHED        = 'isa_max_touches_reached',
  ISA_APPOINTMENT_SCHEDULED      = 'isa_appointment_scheduled',
  ISA_OUTREACH_PAUSED            = 'isa_outreach_paused',

  // ── Consent & TCPA ───────────────────────────────────────────────────────
  CONSENT_RECEIVED               = 'consent_received',
  LEAD_READY_FOR_ASSIGNMENT      = 'lead_ready_for_assignment',

  // ── Assignment ───────────────────────────────────────────────────────────
  LEAD_ASSIGNED                  = 'lead_assigned',
  LEAD_ASSIGNMENT_FAILED         = 'lead_assignment_failed',
  LEAD_CLAIMED                   = 'lead_claimed',

  // ── Conversion ───────────────────────────────────────────────────────────
  LEAD_CONVERTED_TO_CONTACT      = 'lead_converted_to_contact',

  // ── Lead Capture Channels ────────────────────────────────────────────────
  QR_SCAN_RECEIVED               = 'qr_scan_received',
  FORM_SUBMISSION_RECEIVED       = 'form_submission_received',
  BUSINESS_CARD_UPLOADED         = 'business_card_uploaded',
  BUSINESS_CARD_APPROVED         = 'business_card_approved',
  LEAD_IMPORT_COMPLETED          = 'lead_import_completed',
  WEBSITE_VISITOR_IDENTIFIED     = 'website_visitor_identified',
  REFERRAL_RECEIVED              = 'referral_received',

  // ── Re-engagement ────────────────────────────────────────────────────────
  GHOST_LEAD_DETECTED            = 'ghost_lead_detected',
  REENGAGEMENT_STARTED           = 'reengagement_started',
  REENGAGEMENT_COMPLETED         = 'reengagement_completed',

  // ── SLA ──────────────────��───────────────────────────────────────────────
  LEAD_SLA_BREACHED              = 'lead_sla_breached',
  STALE_LEAD_ALERT               = 'stale_lead_alert',

  // ── Enrichment ───────────────────────────────────────────────────────────
  ENRICHMENT_COMPLETED           = 'enrichment_completed',
  ENRICHMENT_FAILED              = 'enrichment_failed',
}
