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
  LISTING_AGREEMENT_SIGNED                  = 'listing_agreement_signed',
  LISTING_AGREEMENT_INITIATED               = 'listing_agreement_initiated',
  SELLER_DECLINED                           = 'seller_declined',
  LISTING_STAGE_CHANGED                     = 'listing_stage_changed',
  LISTING_CANCELLED                         = 'listing_cancelled',
  LISTING_EXPIRED                           = 'listing_expired',
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

  // ── Consent & TCPA ──────────────────────────���────────────────────────────
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

  // ── BUYER LIFECYCLE (Layer 5) ────────────────────────────────────────────
  BUYER_STATE_CHANGED            = 'buyer_state_changed',
  BUYER_FINANCIALLY_VERIFIED     = 'buyer_financially_verified',
  BUYER_SEARCH_CONFIGURED        = 'buyer_search_configured',
  PROPERTY_MATCH_FOUND           = 'property_match_found',
  BUYER_SEARCH_EXECUTED          = 'buyer_search_executed',
  PROPERTY_RECOMMENDED           = 'property_recommended',
  SEARCH_ALERT_TRIGGERED         = 'search_alert_triggered',
  TOUR_PLANNED                   = 'tour_planned',
  TOUR_COMPLETED                 = 'tour_completed',
  BUYER_FATIGUE_DETECTED         = 'buyer_fatigue_detected',
  BUYER_FATIGUE_ALERT            = 'buyer_fatigue_alert',
  OFFER_STRATEGY_RECOMMENDED     = 'offer_strategy_recommended',
  BUYER_OFFER_DRAFT_STARTED      = 'buyer_offer_draft_started',
  BUYER_OFFER_SUBMITTED          = 'buyer_offer_submitted',
  BUYER_UNDER_CONTRACT           = 'buyer_under_contract',
  BUYER_OFFER_ELIGIBLE           = 'buyer_offer_eligible',

  // ── PROPERTY ALERTS (Layer 5 - B06) ──────────────────────────────────────
  PROPERTY_ALERT_CREATED         = 'property_alert_created',
  PROPERTY_ALERT_MATCHED         = 'property_alert_matched',
  PROPERTY_ALERT_PAUSED          = 'property_alert_paused',

  // ── Re-engagement ────────────────────────────────────────────────────────
  GHOST_LEAD_DETECTED            = 'ghost_lead_detected',
  REENGAGEMENT_STARTED           = 'reengagement_started',
  REENGAGEMENT_COMPLETED         = 'reengagement_completed',

  // ── TRANSACTION ORCHESTRATION (Layer 6) ──────────────────────────────────
  TRANSACTION_STAGE_CHANGED           = 'transaction_stage_changed',
  INSPECTION_ORDERED                  = 'inspection_ordered',
  INSPECTION_QUOTE_REQUESTED          = 'inspection_quote_requested',
  INSPECTION_QUOTE_APPROVED           = 'inspection_quote_approved',
  INSURANCE_QUOTE_REQUESTED           = 'insurance_quote_requested',
  INSURANCE_QUOTE_APPROVED            = 'insurance_quote_approved',
  EARNEST_MONEY_RECEIVED              = 'earnest_money_received',
  EARNEST_MONEY_MILESTONE_COMPLETED   = 'earnest_money_milestone_completed',
  APPRAISAL_ORDERED                   = 'appraisal_ordered',
  APPRAISAL_COMPLETED                 = 'appraisal_completed',
  FINANCING_CLEAR_TO_CLOSE            = 'financing_clear_to_close',
  CDA_GENERATED                       = 'cda_generated',
  CDA_APPROVED                        = 'cda_approved',
  DEAL_HEALTH_CHANGED                 = 'deal_health_changed',
  TRANSACTION_COMPLIANCE_FAILED       = 'transaction_compliance_failed',
  TRANSACTION_COMPLIANCE_PASSED       = 'transaction_compliance_passed',
  MILESTONE_COMPLETED                 = 'milestone_completed',
  MILESTONE_OVERDUE                   = 'milestone_overdue',
  POST_CLOSING_PLAN_GENERATED         = 'post_closing_plan_generated',

  // ── SLA ──────────────────────────────────────────────────────────────────
  LEAD_SLA_BREACHED              = 'lead_sla_breached',
  STALE_LEAD_ALERT               = 'stale_lead_alert',

  // ── Enrichment ───────────────────────────────────────────────────────────
  ENRICHMENT_COMPLETED           = 'enrichment_completed',
  ENRICHMENT_FAILED              = 'enrichment_failed',

  // ── Layer 8 — Video / Content Generation ────────────────────────────────
  SCRIPT_GENERATED               = 'script_generated',
  SCRIPT_VARIATION_CREATED       = 'script_variation_created',
  SCRIPT_APPROVED                = 'script_approved',
  SCRIPT_REJECTED                = 'script_rejected',

  // ── Layer 8.2 — Video Generation Engine ────────────────────────────────
  VIDEO_GENERATION_REQUESTED     = 'video_generation_requested',
  VIDEO_PREVIEW_READY            = 'video_preview_ready',
  VIDEO_PUBLISHED                = 'video_published',
  VIDEO_GENERATION_FAILED        = 'video_generation_failed',

  // ── Layer 8.3 — Voice Clone Engine ────────────────────────────────────
  VOICE_CLONE_PROFILE_CREATED    = 'voice_clone_profile_created',
  VOICE_CLONE_SAMPLE_UPLOADED    = 'voice_clone_sample_uploaded',
  VOICE_CLONE_TRAINING_STARTED   = 'voice_clone_training_started',
  VOICE_CLONE_TRAINING_COMPLETED = 'voice_clone_training_completed',
  VOICE_CLONE_TRAINING_FAILED    = 'voice_clone_training_failed',
  VOICE_CLONE_READY              = 'voice_clone_ready',
  VOICE_CLONE_DEFAULT_SET        = 'voice_clone_default_set',

  // ── Layer 8.4 — Snippet & Repurposing Engine ────────────────────────────
  SNIPPET_CREATED                = 'snippet_created',
  SNIPPET_APPROVED               = 'snippet_approved',
  SNIPPET_REJECTED               = 'snippet_rejected',
  SNIPPET_SCHEDULED              = 'snippet_scheduled',
  SNIPPET_PUBLISHED              = 'snippet_published',
  CONTENT_REPURPOSED             = 'content_repurposed',
  REPURPOSE_BATCH_COMPLETED      = 'repurpose_batch_completed',

  // ── Layer 8.5 — Video Performance Tracking ────────────────────────────
  VIDEO_PERFORMANCE_UPDATED      = 'video_performance_updated',
  VIDEO_HIGH_PERFORMER_DETECTED  = 'video_high_performer_detected',
  VIDEO_LOW_PERFORMER_DETECTED   = 'video_low_performer_detected',

  // ── Layer 9 — Marketing & Automation ────────────────────────────────────
  MARKETING_CAMPAIGN_CREATED         = 'marketing_campaign_created',
  MARKETING_CAMPAIGN_APPROVED        = 'marketing_campaign_approved',
  MARKETING_CAMPAIGN_LAUNCHED        = 'marketing_campaign_launched',
  MARKETING_CAMPAIGN_PAUSED          = 'marketing_campaign_paused',
  MARKETING_CAMPAIGN_ENDED           = 'marketing_campaign_ended',

  // ── Layer 9.2 — Social ───────────────────────────────────────────────────
  SOCIAL_POST_SCHEDULED              = 'social_post_scheduled',
  SOCIAL_POST_PUBLISHED              = 'social_post_published',
  SOCIAL_POST_FAILED                 = 'social_post_failed',
  SOCIAL_POST_SHARED_BY_AGENT        = 'social_post_shared_by_agent',

  // ── Layer 9.3 — Content Predictor ────────────────────────────────────────
  CONTENT_PERFORMANCE_PREDICTED      = 'content_performance_predicted',

  // ── Layer 9.4 — Competitive Monitor ─────────────────────────────────────
  COMPETITOR_CONTENT_ALERTED         = 'competitor_content_alerted',

  // ── Layer 9.5 — Ads & Audiences ──────────────────────────────────────────
  AD_CAMPAIGN_CREATED                = 'ad_campaign_created',
  AD_CAMPAIGN_LAUNCHED               = 'ad_campaign_launched',
  RETARGETING_AUDIENCE_CREATED       = 'retargeting_audience_created',
  RETARGETING_AUDIENCE_SYNCED        = 'retargeting_audience_synced',

  // ── Layer 9.6 — SEO & Blog ───────────────────────────────────────────────
  BLOG_POST_GENERATED                = 'blog_post_generated',
  BLOG_POST_PUBLISHED                = 'blog_post_published',

  // ── Layer 9.7 — Newsletter ───────────────────────────────────────────────
  NEWSLETTER_SCHEDULED               = 'newsletter_scheduled',
  NEWSLETTER_SENT                    = 'newsletter_sent',

  // ── Layer 9.8 — Podcast ──────────────────────────────────────────────────
  PODCAST_EPISODE_GENERATED          = 'podcast_episode_generated',
  PODCAST_EPISODE_DISTRIBUTED        = 'podcast_episode_distributed',
  PODCAST_EPISODE_FAILED             = 'podcast_episode_failed',

  // ── Layer 9.9 — Direct Mail ──────────────────────────────────────────────
  DIRECT_MAIL_CAMPAIGN_CREATED       = 'direct_mail_campaign_created',
  DIRECT_MAIL_SENT                   = 'direct_mail_sent',

  // ── Layer 9.10 — Listing Tier ────────────────────────────────────────────
  LISTING_TIER_ASSIGNED              = 'listing_tier_assigned',

  // ── Layer 9.11 — Omni-Presence ──────────────────────────────────────────
  OMNIPRESENCE_PIPELINE_STARTED      = 'omnipresence_pipeline_started',
  OMNIPRESENCE_PIPELINE_COMPLETED    = 'omnipresence_pipeline_completed',

  // ── Layer 9.12 — ROI ─────────────────────────────────────────────────────
  CAMPAIGN_ROI_UPDATED               = 'campaign_roi_updated',
  QR_ATTACHED_TO_ASSET               = 'qr_attached_to_asset',

  // ── Layer 11: Agent Onboarding & Education ─────────────────────────────────
  AGENT_LICENSE_SUBMITTED            = 'agent_license_submitted',
  AGENT_LICENSE_VERIFIED             = 'agent_license_verified',
  AGENT_LICENSE_FAILED               = 'agent_license_failed',
  CONTRACT_SENT_FOR_SIGNATURE        = 'contract_sent_for_signature',
  CONTRACT_SIGNED                    = 'contract_signed',
  BRAND_SETUP_STARTED                = 'brand_setup_started',
  BRAND_SETUP_COMPLETED              = 'brand_setup_completed',
  INTEGRATION_CONNECTED              = 'integration_connected',
  INTEGRATION_FAILED                 = 'integration_failed',
  INTEGRATION_DISCONNECTED           = 'integration_disconnected',
  INTEGRATION_TOKEN_REFRESHED        = 'integration_token_refreshed',
  INTEGRATION_TOKEN_EXPIRED          = 'integration_token_expired',
  OAUTH_REAUTH_REQUIRED              = 'oauth_reauth_required',
  CRM_SYNC_PUSHED                    = 'crm_sync_pushed',
  CRM_SYNC_FAILED                    = 'crm_sync_failed',
  SMS_SEND_REQUESTED                 = 'sms_send_requested',
  EMAIL_SEND_REQUESTED               = 'email_send_requested',
  ESIGN_ENVELOPE_REQUESTED           = 'esign_envelope_requested',
  CALENDAR_EVENT_REQUESTED           = 'calendar_event_requested',
  ACCOUNTING_PUSH_REQUESTED          = 'accounting_push_requested',
  PAYMENT_REQUESTED                  = 'payment_requested',
  SHOWING_REQUEST_SENT               = 'showing_request_sent',
  TRAINING_VIDEO_STARTED             = 'training_video_started',
  TRAINING_VIDEO_COMPLETED           = 'training_video_completed',
  TRAINING_COURSE_ENROLLED           = 'training_course_enrolled',
  TRAINING_COURSE_COMPLETED          = 'training_course_completed',
  SETUP_ASSISTANT_QUERY_MADE         = 'setup_assistant_query_made',
  SETUP_ASSISTANT_ESCALATED          = 'setup_assistant_escalated',
  CERTIFICATION_AWARDED              = 'certification_awarded',
  ONBOARDING_COMPLETED               = 'onboarding_completed',
  ONBOARDING_STALLED                 = 'onboarding_stalled',

  // ── Layer 12 — AI Intelligence Mesh ─────────────────────────────────────────
  DAILY_BRIEFING_GENERATED           = 'daily_briefing_generated',
  DEAL_HEALTH_SCORE_UPDATED          = 'deal_health_score_updated',
  DEAL_AT_RISK_DETECTED              = 'deal_at_risk_detected',
  INTENT_CLASSIFIED                  = 'intent_classified',
  COACHING_REPORT_GENERATED          = 'coaching_report_generated',
  PROACTIVE_INTERVENTION_TRIGGERED   = 'proactive_intervention_triggered',
  KB_ARTICLE_EMBEDDED                = 'kb_article_embedded',
  MEMORY_CONTEXT_UPDATED             = 'memory_context_updated',

  // ── Layer 12 — Multi-Agent Coordination ─────────────────────────────────────
  AGENT_SESSION_STARTED              = 'agent_session_started',
  AGENT_TASK_DISPATCHED              = 'agent_task_dispatched',
  AGENT_HANDOFF_INITIATED            = 'agent_handoff_initiated',
  AGENT_HANDOFF_COMPLETED            = 'agent_handoff_completed',
  AGENT_ESCALATED_TO_HUMAN           = 'agent_escalated_to_human',
  AGENT_SESSION_ENDED                = 'agent_session_ended',

  // ── Layer 12 — Market Intelligence ──────────────────────────────────────────
  MARKET_INSIGHT_GENERATED           = 'market_insight_generated',
  MARKET_DATA_REFRESHED              = 'market_data_refreshed',
}
