// scripts/check-vocabularies.ts — GENERATED from the live database. Do not hand-edit.
//
// Every single-column CHECK constraint in public that admits a fixed set of text
// values, snapshotted so a pure guard can compare source literals against what
// the database will actually accept. Nullable variants
// (`col IS NULL OR col = ANY (...)`) are included — the NULL case is not a value,
// so it does not widen the vocabulary.
//
// WHY THIS EXISTS. supabase-js resolves with `{ error }` rather than throwing, and
// most writes here are best-effort, so a literal the CHECK rejects loses the row in
// silence. Four shipped defects in one sweep came from exactly this: a "stalled"
// onboarding status the CHECK forbids (a permanently-zero metric), "watch"/"warning"
// fatigue levels (the whole middle band of scores vanished), a "fatigue_critical"
// alert type (critical alerts rendered as warnings), and a listing sweep filtering
// lifecycle_stage="active" and status="closed" — neither of which exists — so it
// matched zero rows on every run since it shipped.
//
// Snapshot: 428 tables, 730 columns.

export const CHECK_VOCABULARIES: Record<string, Record<string, string[]>> = {
  accounting_sync_log: {
    provider: ["quickbooks", "xero"],
    status: ["completed", "failed", "pending", "running"],
    sync_type: ["commission", "expense", "full", "invoice", "journal"],
  },
  ad_campaigns: {
    platform: ["facebook", "google", "instagram", "linkedin", "tiktok", "vibe_ctv"],
    status: ["approved", "draft", "ended", "failed", "launching", "live", "paused", "pending_review"],
    visibility_scope: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  ad_creative_variations: {
    approval_status: ["approved", "draft", "pending_review", "rejected"],
  },
  ad_insights: {
    source_type: ["competitor_ad", "competitor_analysis", "competitor_post"],
  },
  ad_manager_actions: {
    action_type: ["launch_ad_campaign", "pause_ad_campaign", "scale_ad_creative", "shift_ad_budget"],
    status: ["approved", "executing", "failed", "proposed", "skipped", "succeeded"],
  },
  ad_retarget_presets: {
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  affiliate_commission_events: {
    status: ["accrued", "paid", "void"],
  },
  agent_assistant_sessions: {
    ended_reason: ["cap_reached", "disconnected", "error", "timeout", "user_ended"],
  },
  agent_avatar_assets: {
    approval_status: ["approved", "pending", "rejected"],
    source_type: ["photo", "video"],
    status: ["failed", "pending", "processing", "ready"],
  },
  agent_ce_completions: {
    category: ["core", "elective", "ethics", "fair_housing", "other"],
  },
  agent_certifications: {
    cert_type: ["advanced", "compliance", "onboarding", "specialty"],
  },
  agent_client_messages: {
    audience: ["agent", "buyer", "lead", "seller"],
    channel: ["direct_mail", "email", "portal", "portal_push", "sms", "voice_drop"],
    status: ["approved", "failed", "proposed", "rejected", "sent"],
  },
  agent_commission_profiles: {
    desk_fee_type: ["flat", "percent"],
    eo_fee_type: ["flat", "percent"],
    referral_type: ["flat", "percent"],
    residual_type: ["flat", "percent"],
    royalty_type: ["flat", "percent"],
    structure_type: ["flat_cap", "multi_layer", "split", "team", "tiered"],
    technology_fee_type: ["flat", "percent"],
    transaction_fee_type: ["flat", "percent"],
  },
  agent_commissions: {
    side: ["both", "buying", "listing"],
    status: ["approved", "disputed", "paid", "pending"],
  },
  agent_coordination_log: {
    action_type: ["context_updated", "escalated_to_human", "goal_achieved", "handoff_accepted", "handoff_initiated", "handoff_rejected", "session_ended", "session_started", "task_completed", "task_dispatched", "task_failed"],
    agent_type: ["coaching_agent", "content_agent", "human", "isa_agent", "none", "router", "tc_agent"],
    entity_type: ["contact", "lead", "listing", "transaction"],
  },
  agent_earnings: {
    cap_status: ["at_cap", "below_cap", "post_cap"],
    period_type: ["all_time", "mtd", "single", "ytd"],
  },
  agent_fee_charges: {
    status: ["disputed", "open", "overdue", "paid", "waived"],
  },
  agent_goals: {
    goal_type: ["avg_days_to_close", "buyer_clients", "conversion_rate", "gross_commission", "listings_taken", "new_contacts", "referrals_generated", "reviews_requested", "transactions_closed"],
  },
  agent_handoffs: {
    entity_type: ["contact", "lead", "listing", "transaction"],
    from_agent_type: ["coaching_agent", "content_agent", "human", "isa_agent", "none", "router", "tc_agent"],
    handoff_status: ["accepted", "completed", "pending", "rejected", "timed_out"],
    to_agent_type: ["coaching_agent", "content_agent", "human", "isa_agent", "none", "router", "tc_agent"],
  },
  agent_intro_videos: {
    delivery_channel: ["both", "email", "portal"],
    status: ["delivered", "failed", "queued", "rendering", "suppressed"],
    trigger: ["contact_agent_assigned", "home_anniversary"],
  },
  agent_licenses: {
    license_status: ["active", "expired", "pending", "revoked", "suspended"],
    license_type: ["broker", "broker_associate", "salesperson"],
    verification_status: ["failed", "pending", "unverified", "verified"],
  },
  agent_mentor_relationships: {
    status: ["active", "cancelled", "completed", "paused"],
  },
  agent_onboarding: {
    status: ["completed", "in_progress", "paused"],
  },
  agent_onboarding_sessions: {
    session_type: ["brand_setup", "certification", "compliance", "license_review", "orientation", "tech_training"],
    status: ["cancelled", "completed", "in_progress", "scheduled"],
  },
  agent_onboarding_steps: {
    status: ["completed", "in_progress", "pending", "skipped"],
    step_type: ["approval", "form", "quiz", "task", "video"],
  },
  agent_outcome_evaluations: {
    result: ["failed", "interrupted", "max_iterations_reached", "needs_revision", "satisfied"],
  },
  agent_relationships: {
    relationship_type: ["mentor", "sponsor", "team_lead"],
    source_of_funds: ["agent", "brokerage"],
  },
  agent_retention_scores: {
    score_trend: ["declining", "improving", "stable"],
    tier: ["at_risk", "critical", "engaged", "healthy", "watch"],
  },
  agent_reviews: {
    platform: ["facebook", "google", "internal", "realtor_com", "yelp", "zillow"],
  },
  agent_state_machine: {
    entity_type: ["contact", "lead", "listing", "transaction"],
  },
  agent_voice_profiles: {
    default_expression: ["happy", "neutral", "serious", "surprise"],
    training_status: ["collecting_samples", "failed", "not_started", "ready", "training"],
  },
  agents: {
    onboarding_status: ["completed", "in_progress", "not_started", "pending_review"],
    voice_preference: ["clone", "generic"],
    widget_position: ["left", "right"],
  },
  ai_assistant_notes: {
    note_type: ["action_item", "call_outcome", "decision", "follow_up", "general", "loan_update", "meeting_outcome", "observation", "review_monitoring_config", "review_recovery_plan", "review_request_draft", "vendor_update"],
    source: ["ai_assistant", "ai_draft_human_approved", "human"],
  },
  ai_autopilot_actions: {
    priority: ["critical", "high", "low", "medium"],
    status: ["cancelled", "executed", "pending", "skipped"],
  },
  ai_comp_scores: {
    confidence_level: ["high", "low", "medium"],
  },
  ai_feedback_log: {
    source_system: ["behavioral_pattern", "coaching_report", "content_generation", "conversation_memory", "daily_briefing", "deal_health", "intent_classifier", "isa_response", "market_insight", "onboarding_assistant", "smart_suggestion"],
  },
  ai_identity_profiles: {
    ai_answer_mode: ["after_hours", "always"],
    formality_level: ["casual", "formal", "semi_formal"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
    tone: ["authoritative", "conversational", "friendly", "luxury", "professional", "warm"],
    voice_mode: ["assistant", "clone", "front_office"],
    voice_provider: ["elevenlabs"],
  },
  ai_isa_activities: {
    activity_type: ["appointment_set", "automation_paused", "automation_resumed", "automation_started", "call", "direct_mail", "email", "follow_up", "info_guide", "open_house_invite", "outcome_recorded", "property_alert", "seller_intent_prioritized", "social", "text", "tour_plan", "video", "voicedrop"],
    channel: ["direct_mail", "email", "in_app", "phone", "sms", "social", "video", "voicedrop"],
  },
  ai_isa_call_batches: {
    status: ["approved", "cancelled", "completed", "proposed", "rejected"],
  },
  ai_isa_campaigns: {
    campaign_type: ["buyer_match", "divorce", "foreclosure", "fsbo", "ghost_recovery", "search_intent", "social_intent"],
    status: ["active", "archived", "completed", "draft", "paused"],
  },
  ai_isa_engagement_tracking: {
    channel: ["direct_mail", "email", "phone", "sms", "system", "video"],
    event_type: ["bounced", "clicked", "delivered", "opened", "replied", "sent", "suppressed", "unsubscribed"],
  },
  ai_isa_qualifications: {
    qualification_result: ["appointment_set", "needs_follow_up", "no_response", "not_qualified", "qualified"],
  },
  ai_message_drafts: {
    channel: ["email", "in_app", "sms"],
    status: ["accepted", "dismissed", "edited", "pending", "sent"],
    suggested_tone: ["informational", "professional", "urgent", "warm"],
  },
  ai_quota_overrides: {
    status: ["approved", "denied", "expired", "pending"],
  },
  ai_search_citation_observations: {
    outcome: ["cited", "not_checked", "not_cited"],
    platform: ["bing_copilot", "chatgpt", "gemini", "google_ai_overviews", "perplexity"],
  },
  ai_search_landing_citation_observations: {
    outcome: ["cited", "not_checked", "not_cited"],
    platform: ["bing_copilot", "chatgpt", "gemini", "google_ai_overviews", "perplexity"],
  },
  ai_video_projects: {
    approval_status: ["approved", "draft", "pending_review", "published", "rejected"],
    audience_type: ["customer_facing", "in_house"],
    compliance_status: ["failed", "needs_review", "not_evaluated", "passed"],
    // m374. Source of truth: CANONICAL_VIDEO_STATUSES in lib/video/video-status.ts.
    // Before m374 this column had NO CHECK and 22 spellings — five of them read
    // by filters nothing wrote, so the panels behind them were structurally empty.
    status: ["awaiting_presenter_setup", "completed", "draft", "failed", "generating", "published", "queued", "script_ready", "scripting"],
    usage_intent: ["both", "mls", "public_marketing"],
    video_provider: ["did", "upload"],
    video_type: ["agent_intro", "avatar_explainer", "coming_soon", "education", "just_listed", "just_sold", "listing_promo", "listing_tour", "market_update", "memory_video", "open_house_promo", "pre_appointment", "presentation_chapter", "social_reel", "testimonial", "welcome"],
  },
  appointments: {
    status: ["cancelled", "completed", "confirmed", "no_show", "scheduled"],
  },
  approval_items: {
    status: ["approved", "pending", "rejected"],
  },
  asset_manager_actions: {
    action_type: ["deprecate_asset", "flag_asset_for_review", "publish_video_page", "regenerate_asset", "request_agent_headshot", "request_listing_hero_photo", "rerender_persona_variants", "restart_failed_render", "start_render", "sync_asset_to_listing"],
    status: ["approved", "executing", "failed", "proposed", "skipped", "succeeded"],
  },
  asset_persona_renders: {
    asset_type: ["blog_post", "direct_mail", "landing_page", "listing_promo", "marketing_plan_item", "newsletter_campaign", "newsletter_video", "podcast_episode", "social_post"],
    status: ["completed", "failed", "queued", "rendering", "skipped"],
  },
  assignment_log: {
    assignment_method: ["ai_recommendation", "load_balance", "manual", "round_robin", "rule_match"],
  },
  assignment_rules: {
    rule_type: ["geo_based", "load_balance", "manual", "round_robin", "specialization"],
  },
  audience_members: {
    sync_status: ["failed", "pending", "removed", "synced"],
  },
  audience_sync_runs: {
    run_status: ["completed", "failed", "queued", "running"],
  },
  automation_errors: {
    status: ["dismissed", "investigating", "open", "resolved"],
  },
  behavioral_patterns: {
    entity_type: ["buyer", "negotiation", "seller"],
    pattern_type: ["competitor_threat", "contentious_negotiation", "deal_collapse_risk", "disengagement_risk", "financing_risk", "high_motivation", "offer_imminent", "price_reduction_likely"],
  },
  billing_invoices: {
    status: ["draft", "open", "paid", "uncollectible", "void"],
  },
  blog_cadence_policy: {
    cadence: ["biweekly", "monthly", "off", "weekly"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  blog_posts: {
    publish_status: ["approved", "archived", "draft", "pending_review", "published", "rejected", "scheduled"],
    publish_target: ["both", "embed", "hosted", "wordpress"],
    visibility_scope: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  brand_asset_library: {
    asset_kind: ["agent_headshot", "brand_color_palette", "hero_template", "logo", "remotion_composition", "team_logo", "video_avatar", "voice_clone"],
  },
  brand_templates: {
    template_type: ["business_card", "custom", "email_signature", "letterhead"],
  },
  brand_voice_profile: {
    formality_level: ["casual", "formal", "semi_formal"],
    tone: ["authoritative", "conversational", "friendly", "luxury", "professional", "warm"],
  },
  brokerage_cda_template_fields: {
    field_type: ["currency", "date", "percent", "text"],
    source: ["agent_input", "static", "transaction", "waterfall"],
  },
  brokerage_cda_templates: {
    transaction_type: ["dual", "lease", "referral", "sale_buy", "sale_sell"],
  },
  brokerage_earnings: {
    period_type: ["annual", "monthly", "quarterly"],
  },
  brokerage_fee_types: {
    applies_to: ["all_agents", "role", "specific_agents", "team"],
    cadence: ["annual", "monthly", "one_time", "per_transaction", "quarterly"],
  },
  brokerage_form_library: {
    packet_type: ["custom", "disclosure", "listing", "offer", "transaction"],
  },
  brokerage_integrations: {
    status: ["connected", "error", "not_configured"],
  },
  brokerage_intelligence_insights: {
    severity: ["critical", "high", "low", "medium"],
    status: ["dismissed", "expired", "open", "superseded"],
  },
  brokerage_required_documents: {
    classification: ["addendum", "agency_disclosure", "appraisal_report", "closing_disclosure", "commission_agreement", "counter_offer", "disclosure", "earnest_money_receipt", "hoa_documents", "id_document", "inspection_report", "insurance_binder", "lender_letter", "listing_agreement", "other", "pre_approval_letter", "preliminary_closing_statement", "proof_of_funds", "seller_broker_agreement", "signed_contract", "title_report", "wire_instructions"],
    deal_type: ["buyer", "dual", "seller"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  brokerages: {
    default_assignment_method: ["geo_based", "load_balance", "manual", "round_robin", "specialization"],
    non_cda_payout_default: ["check", "direct_deposit"],
    onboarding_status: ["abandoned", "completed", "in_progress", "pending"],
    plan_tier: ["brokerage", "multi_location", "solo_agent", "team"],
    signup_source: ["import", "partner", "self_serve", "superadmin"],
    status: ["active", "archived", "cancelled", "suspended"],
  },
  business_card_scans: {
    review_status: ["approved", "pending", "rejected"],
  },
  buyer_behavior_log: {
    signal_type: ["alert_dismissed", "alert_opened", "dismissed", "filter_applied", "like_it", "love_it", "maybe", "not_for_us", "offer_created", "offer_declined", "portal_visit", "price_range_adjusted", "property_dismissed", "property_saved", "property_shared", "property_viewed", "saved", "search_executed", "search_time_spent", "showing_attended", "showing_no_show", "tour_stop_rated", "viewed"],
    source: ["agent_dashboard", "alert_email", "api", "buyer_portal", "mobile"],
  },
  buyer_behavior_predictions: {
    engagement_velocity: ["accelerating", "decelerating", "stalled", "steady"],
  },
  buyer_broker_agreements: {
    agreement_type: ["exclusive", "non_exclusive", "open", "showing_only"],
    commission_payer: ["buyer", "either", "seller", "split"],
    signed_method: ["authentisign", "click_through", "docusign", "dotloop", "skyslope", "wet_signature"],
    status: ["active", "cancelled", "draft", "expired", "pending_signature", "superseded"],
  },
  buyer_fatigue_scores: {
    engagement_trend: ["declining", "increasing", "stable", "stopped"],
    risk_level: ["critical", "fresh", "high", "moderate"],
  },
  buyer_financial_profiles: {
    finance_type: ["bridge", "cash", "conventional", "fha", "jumbo", "other", "usda", "va"],
    lender_referral_status: ["declined", "in_progress", "not_referred", "pre_approved", "referred"],
    letter_type: ["pre_approval", "pre_qualification"],
  },
  buyer_intake_tokens: {
    status: ["cancelled", "expired", "pending", "submitted"],
  },
  buyer_move_cases: {
    case_status: ["active", "blocked", "completed", "draft", "handoff_started"],
    recommended_mode: ["contact_assisted_guided_diy", "handoff"],
    service_mode: ["contact_assisted_guided_diy", "handoff"],
  },
  buyer_tours: {
    status: ["cancelled", "completed", "in_progress", "scheduled"],
  },
  calendar_provider_accounts: {
    provider_type: ["google_calendar", "outlook"],
    sync_direction: ["bidirectional", "inbound", "outbound"],
  },
  calendar_sync_conflicts: {
    resolution: ["app_wins", "manual_review", "merged", "provider_wins"],
  },
  calendar_sync_logs: {
    direction: ["both", "pull", "push"],
    status: ["failed", "partial", "success"],
  },
  calendar_sync_mappings: {
    provider_type: ["google_calendar", "outlook"],
  },
  call_analyses: {
    sentiment: ["mixed", "negative", "neutral", "positive"],
  },
  call_coaching_insights: {
    insight_type: ["closing", "improvement", "objection_handling", "rapport", "strength"],
    priority: ["high", "low", "medium"],
  },
  campaign_bundle_items: {
    channel: ["ad_retarget", "direct_mail_letter", "direct_mail_postcard", "email", "podcast_episode", "portal_push", "sms", "social_post", "voicedrop"],
  },
  campaign_bundles: {
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  campaign_calendar: {
    event_type: ["deadline", "launch", "mail_drop", "podcast_release", "publish", "review", "send"],
    status: ["cancelled", "completed", "failed", "in_progress", "scheduled"],
  },
  campaign_sequence_steps: {
    ab_variant: ["A", "B"],
    channel: ["ad_campaign", "add_to_segment", "ai_call", "ai_image", "assign_task", "avm_cma", "commission_video", "condition", "direct_mail", "draft_document", "email", "in_app", "listing_landing_page", "newsletter", "remove_from_campaign", "schedule_showing", "schedule_tour", "send_for_esign", "send_gift", "sms", "social_post", "video", "voice_drop", "wait"],
  },
  campaign_sequences: {
    contact_type: ["both", "buyer", "lifetime", "seller"],
    persona: ["divorce", "downsize", "expired", "first_time", "foreclosure", "fsbo", "luxury", "military", "other", "probate", "relocated", "senior", "upsize"],
    sequence_type: ["drip", "nurture", "post_close", "re_engagement", "transaction"],
    trigger_event: ["anniversary_triggered", "appraisal_ordered", "buyer_financially_verified", "buyer_verified", "cda_approved", "coming_soon_sent", "contact_captured", "contact_created", "contact_email_opened", "contact_link_clicked", "contract_signed", "deal_closed", "ghl_contact_tag_added", "ghost_lead_detected", "idx_saved_search_match", "isa_qualified_lead", "lead_assigned", "lead_captured", "lead_scored", "lifetime_customer", "listing_cancelled", "listing_created", "listing_expired", "listing_published", "listing_under_contract", "manual", "new_lead", "offer_accepted", "offer_counter_sent", "offer_rejected", "offer_submitted", "open_house_scheduled", "property_match_found", "qr_scan", "reengagement_started", "review_received", "showing_completed", "showing_feedback_received", "tour_scheduled", "transaction_closed"],
  },
  chat_messages: {
    role: ["assistant", "system", "user"],
  },
  chat_sessions: {
    session_type: ["internal", "internal_assistant", "portal_widget", "voice", "website_widget"],
  },
  client_documents: {
    doc_category: ["appraisal", "bank_statement", "contract", "disclosure", "employment_verification", "gift_letter", "inspection_report", "insurance", "offer_form", "other", "pre_approval_letter", "proof_of_funds", "tax_return", "title"],
  },
  client_portal_messages: {
    direction: ["agent_to_client", "client_to_agent"],
  },
  closing_cost_accuracy_observations: {
    side: ["buyer", "seller"],
  },
  closing_disclosure_agreement: {
    non_cda_payout_method: ["check", "direct_deposit"],
    sent_to_title_method: ["docusign", "dotloop", "email", "manual"],
  },
  closing_disclosure_agreement_revisions: {
    action: ["approved", "cancelled", "changes_requested", "drafted", "rejected", "signed_off", "submitted"],
  },
  closing_gifts: {
    status: ["cancelled", "delivered", "ordered", "scheduled", "shipped"],
  },
  cma_packages: {
    status: ["cancelled", "error", "generating", "ready"],
  },
  cma_reports: {
    status: ["archived", "draft", "presented", "ready"],
  },
  collaborative_search_members: {
    invite_status: ["accepted", "declined", "pending"],
    role: ["editor", "owner", "viewer"],
  },
  collaborative_search_properties: {
    status: ["active", "removed", "shortlisted"],
  },
  collaborative_searches: {
    status: ["active", "archived", "completed"],
  },
  commission_adjustments: {
    adjustment_type: ["charity_donation", "credit", "custom", "discount", "first_responder", "rate_override"],
    applies_to: ["agent", "brokerage", "gross"],
    direction: ["credit", "surcharge"],
    recipient_type: ["agent", "brokerage", "buyer", "charity", "seller"],
    value_type: ["flat", "percent"],
  },
  commission_distributions: {
    calculation_type: ["flat", "percent"],
    cap_status: ["hit_cap", "n/a", "post_cap", "pre_cap"],
    distribution_type: ["agent", "brokerage", "fee", "referral", "residual", "royalty", "team_member"],
    source_of_funds: ["agent", "brokerage", "buyer", "seller_concession"],
    status: ["approved", "paid", "pending", "voided"],
  },
  commission_rules: {
    applies_to_level: ["gross", "post_cap", "post_split"],
    calculation_type: ["flat", "percent"],
    rule_type: ["desk_fee", "eo_fee", "override", "referral", "residual", "royalty", "team_split", "technology_fee", "transaction_fee"],
    source_of_funds: ["agent", "brokerage"],
  },
  commission_splits: {
    status: ["approved", "cancelled", "disputed", "paid", "pending"],
  },
  commission_structures: {
    commission_type: ["flat", "percentage", "tiered"],
  },
  communication_audit_log: {
    lead_temperature: ["cold", "hot", "warm"],
  },
  communications: {
    direction: ["inbound", "outbound"],
  },
  comp_risk_flags: {
    risk_type: ["data_gap", "declining_comps", "limited_comps", "low_confidence", "market_shift", "price_outlier", "stale_comps", "unusual_property"],
    severity: ["critical", "high", "low", "medium"],
  },
  competitor_ads: {
    source_platform: ["facebook", "google", "instagram"],
  },
  competitor_posts: {
    source_platform: ["facebook", "instagram", "linkedin", "tiktok", "x", "youtube"],
  },
  competitor_profiles: {
    competitor_type: ["agent", "brokerage", "franchise", "team"],
  },
  compliance_alerts: {
    severity: ["critical", "high", "low", "medium"],
  },
  compliance_flags: {
    status: ["flagged", "overridden", "resolved", "reviewed"],
  },
  compliance_rules: {
    severity: ["critical", "high", "low", "medium"],
  },
  compliance_tasks: {
    status: ["complete", "overdue", "pending", "waived"],
  },
  contact_enrichment_queue: {
    status: ["completed", "failed", "pending", "running", "skipped"],
  },
  contact_memory: {
    entity_type: ["contact", "listing", "transaction"],
    memory_kind: ["agent_message", "agent_note", "bba_event", "persona_signal", "portal_message", "preference", "showing_feedback", "transparency_update"],
  },
  contact_suppression_list: {
    channel: ["email", "mail", "phone", "sms"],
  },
  contact_vendors: {
    status: ["active", "declined", "inactive"],
  },
  contacts: {
    ai_autopilot_level: ["aggressive", "conservative", "moderate", "off"],
    buyer_stage: ["BUYER_CLOSED", "BUYER_CONTACT_CREATED", "BUYER_DISENGAGED", "BUYER_FINANCIALLY_VERIFIED", "BUYER_LIFETIME", "BUYER_OFFER_ELIGIBLE", "BUYER_OFFER_SUBMITTED", "BUYER_ON_HOLD", "BUYER_SEARCHING", "BUYER_SEARCH_CONFIGURED", "BUYER_TOURING", "BUYER_TOUR_ELIGIBLE", "BUYER_UNDER_CONTRACT"],
    contact_type: ["both", "buyer", "client", "investor", "lead", "lifetime", "lifetime_customer", "other", "past_client", "prospect", "referral_partner", "seller", "sphere", "vendor"],
    lead_temperature: ["cold", "hot", "warm"],
    lender_status: ["cash", "needs_pre_approval", "pre_approved", "unknown"],
    lifetime_segment: ["local_owner", "relocated"],
    phone_status: ["invalid", "reassigned", "unknown", "valid"],
    referral_potential: ["high", "low", "medium"],
  },
  content_ab_tests: {
    status: ["cancelled", "completed", "running"],
  },
  content_asset_persona_performance: {
    asset_type: ["blog_post", "direct_mail", "landing_page", "listing_promo", "marketing_plan_item", "newsletter_campaign", "newsletter_video", "podcast_episode", "social_post"],
  },
  content_calendar: {
    status: ["cancelled", "draft", "published", "scheduled"],
  },
  content_ideas: {
    status: ["idea", "in_progress", "published"],
  },
  content_performance_predictions: {
    confidence: ["high", "low", "medium"],
    content_type: ["ad_creative", "blog_post", "newsletter", "podcast_episode", "social_post"],
  },
  content_topic_bank: {
    status: ["fresh", "rejected", "stale", "used"],
  },
  content_topic_sources: {
    source_type: ["apify_actor", "google_trends", "manual", "reddit", "rss", "youtube_search"],
  },
  content_topic_uses: {
    asset_type: ["blog_post", "direct_mail_postcard", "marketing_plan_item", "newsletter_campaign", "newsletter_video", "podcast_episode", "situational_reel", "social_post"],
  },
  contract_reviews: {
    review_type: ["ai_automated", "manual"],
  },
  contract_signatures: {
    contract_type: ["acceptance", "addendum", "amendment", "buyer_representation_agreement", "commission_agreement", "contract", "counter_offer", "disclosure", "escrow_instructions", "independent_contractor", "listing_agreement", "nar_code_of_ethics", "policy_acknowledgment", "purchase_agreement", "team_agreement"],
    esign_status: ["agent_signed", "declined", "fully_signed", "pending", "sent", "viewed", "voided"],
  },
  conversation_audit_flags: {
    review_status: ["dismissed", "escalated", "pending", "reviewed"],
    risk_type: ["compliance", "data_leak", "fair_housing", "hallucination", "inappropriate_language", "missed_opportunity"],
  },
  conversation_logs: {
    channel: ["ai_assistant", "chat", "email", "sms", "voice"],
    conversation_type: ["general_inquiry", "lead_nurture", "offer_negotiation", "showing_followup", "transaction_update"],
    sentiment_end: ["negative", "neutral", "positive"],
    sentiment_journey: ["declined", "improved", "stable"],
    sentiment_start: ["negative", "neutral", "positive"],
  },
  copilot_plans: {
    status: ["active", "completed", "paused", "superseded"],
  },
  cost_breakdown_tracking: {
    party: ["buyer", "seller"],
    status: ["confirmed", "estimated", "paid"],
  },
  credit_accounts: {
    account_status: ["active", "archived", "closed", "lead"],
  },
  credit_partner_referrals: {
    status: ["completed", "declined", "in_progress", "referred"],
  },
  cron_execution_logs: {
    status: ["completed", "failed", "started", "timeout"],
  },
  data_health_scans: {
    status: ["cancelled", "completed", "failed", "running"],
  },
  data_subject_requests: {
    request_type: ["access", "correction", "delete", "export", "opt_out_sale", "opt_out_sharing", "portability"],
    source: ["api", "email", "phone", "postal", "web_form"],
    status: ["denied", "expired", "fulfilled", "in_progress", "received", "withdrawn"],
  },
  deal_autopsies: {
    failure_reason: ["appraisal", "cold_feet", "competing_offer", "financing", "inspection", "low_appraisal", "other", "title"],
    terminal_status: ["cancelled", "withdrawn"],
  },
  deal_autopsy_observations: {
    failure_reason: ["appraisal", "cold_feet", "competing_offer", "financing", "inspection", "low_appraisal", "other", "title"],
  },
  deal_health_factors: {
    factor_type: ["agent_responsiveness", "communication_recency", "deadline_proximity", "document_completeness", "financing_status", "party_responsiveness", "task_completion", "timeline_adherence"],
  },
  deal_health_scores: {
    risk_level: ["at_risk", "critical", "healthy", "watch"],
  },
  deal_team_members: {
    member_type: ["agent", "inspector", "insurance_provider", "lender", "other", "title"],
  },
  deconflict_suppression_log: {
    channel: ["ad", "blog", "email", "mail", "newsletter", "phone", "sms", "social_post", "video"],
    outcome: ["allowed", "allowed_with_warning", "suppressed_cooldown", "suppressed_over_touch"],
  },
  deposits: {
    deposit_type: ["additional_deposit", "earnest_money", "option_fee"],
    status: ["delivered", "disbursed", "forfeited", "pending", "received", "returned"],
  },
  direct_mail_campaigns: {
    status: ["approved", "cancelled", "failed", "mailed", "planning", "printed"],
  },
  direct_mail_presets: {
    piece_type: ["letter", "postcard"],
    postcard_size: ["4x6", "6x9"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  direct_mail_recipients: {
    delivery_status: ["delivered", "failed", "mailed", "pending", "returned"],
  },
  direct_mail_responses: {
    response_type: ["appointment", "call", "form_submit", "landing_visit", "qr_scan", "reply"],
  },
  direct_mail_variants: {
    postcard_size: ["4x6", "6x9"],
    use_kind: ["farm_mail", "lifecycle", "pre_listing_kit", "sphere_outreach", "welcome_kit"],
  },
  document_extraction_log: {
    extraction_method: ["ai_claude", "docusign_api", "dotloop_api", "manual", "ocr"],
    processing_status: ["completed", "failed", "pending", "processing"],
  },
  document_field_audit: {
    ai_confidence: ["agent_override", "high", "low", "medium"],
  },
  document_field_extractions: {
    confidence: ["high", "low", "medium"],
  },
  document_folders: {
    folder_type: ["client", "compliance", "marketing", "template", "transaction"],
  },
  document_requests: {
    status: ["approved", "cancelled", "pending", "rejected", "submitted"],
  },
  documents: {
    classification: ["addendum", "agency_disclosure", "appraisal_report", "closing_disclosure", "commission_agreement", "counter_offer", "disclosure", "earnest_money_receipt", "hoa_documents", "id_document", "inspection_report", "insurance_binder", "lender_letter", "listing_agreement", "other", "pre_approval_letter", "preliminary_closing_statement", "proof_of_funds", "seller_broker_agreement", "signed_contract", "title_report", "wire_instructions"],
    classification_confidence: ["high", "low", "medium"],
    status: ["archived", "cancelled", "complete", "declined", "draft", "draft_ready", "generating", "needs_agent_input", "pending_signature", "review", "signed"],
  },
  drip_campaigns: {
    status: ["active", "cancelled", "completed", "paused"],
  },
  email_campaigns: {
    approval_status: ["approved", "pending", "rejected"],
    campaign_format: ["drip", "event_triggered", "one_off", "segmented", "transactional"],
    status: ["cancelled", "draft", "failed", "paused", "scheduled", "sending", "sent"],
  },
  email_presets: {
    channel_purpose: ["campaign", "conversation", "transactional", "update"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  email_queue: {
    status: ["cancelled", "failed", "pending", "sent"],
  },
  email_sends: {
    status: ["bounced", "cancelled", "failed", "queued", "sending", "sent"],
  },
  email_templates: {
    template_type: ["closing", "followup", "offer", "reminder", "welcome"],
  },
  email_tracking: {
    event_type: ["bounce", "click", "deferred", "delivered", "dropped", "open", "sent", "spam_complaint", "unsubscribe"],
  },
  embed_widgets: {
    lead_capture_mode: ["after_first_message", "immediate", "optional"],
    routing_mode: ["primary", "round_robin"],
  },
  embedding_queue: {
    status: ["completed", "failed", "pending", "processing"],
  },
  error_resolution_log: {
    action_type: ["acknowledged", "auto_retry", "escalated", "false_positive", "manual_retry", "resolved", "suppressed"],
    retry_result: ["failure", "pending", "success"],
  },
  event_processing_log: {
    status: ["failure", "skipped", "success"],
  },
  facebook_custom_audiences: {
    audience_type: ["custom", "engagement", "listing_visitors", "lookalike", "newsletter_openers", "persona_segment", "portal_visitors", "video_viewers", "website_visitors"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
    status: ["approved", "deleted", "draft", "failed", "pending_review", "synced"],
    target_platform: ["facebook", "google", "instagram", "linkedin", "tiktok"],
  },
  fatigue_alerts: {
    alert_type: ["disengagement_risk", "fatigue_threshold_crossed", "re_engagement_needed", "search_stalled"],
  },
  feature_access_overrides: {
    override_type: ["disable", "grant_trial"],
  },
  gamification_badges: {
    badge_tier: ["bronze", "diamond", "gold", "platinum", "silver"],
  },
  global_settings: {
    date_format: ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"],
  },
  help_topics_kb: {
    category: ["brand", "certification", "general", "license", "tech_stack", "training"],
  },
  home_value_estimates: {
    // m378 added "unknown": no market_data row covers the property's ZIP/city,
    // so the direction is genuinely not known. The lane used to default to
    // "stable" — an assertion the seller cannot check.
    market_trend: ["appreciating", "depreciating", "stable", "unknown"],
    // m378 added "sqft_regional_average": no comparable sale could be sourced,
    // so the range is sqft × a regional rate. That is not a CMA, and it used to
    // be stamped "ai_cma" anyway.
    methodology: ["ai_cma", "attom", "housecanary", "manual", "sqft_regional_average"],
  },
  inbound_call_classifications: {
    classification: ["business_general", "cooperating_agent", "existing_contact", "real_estate_buyer", "real_estate_investor", "real_estate_seller", "unknown", "vendor"],
  },
  income_gap_recommended_actions: {
    action_category: ["conversion_focus", "listing_acquisition", "marketing_push", "negotiation_close", "open_house", "pricing_correction", "prospecting", "reactivation", "referral_ask", "sphere_nurture"],
    status: ["completed", "dismissed", "expired", "in_progress", "open"],
  },
  ingress_dead_letters: {
    status: ["abandoned", "pending", "reconciled"],
  },
  investor_deal_matches: {
    status: ["active", "archived"],
  },
  isa_outreach_log: {
    channel: ["direct_mail", "email", "in_app", "sms", "social", "video", "voice"],
    status: ["bounced", "clicked", "opened", "replied", "sent"],
  },
  journey_task_completions: {
    completed_by: ["agent", "contact", "system"],
  },
  keyword_intelligence: {
    trend_direction: ["declining", "rising", "steady"],
  },
  knowledge_articles: {
    category: ["compliance", "general", "integrations", "leads", "marketing", "onboarding", "transactions"],
    status: ["archived", "draft", "published"],
  },
  lead_deduplication_log: {
    action_taken: ["created", "merged", "queued_for_enrichment", "skipped"],
    stage: ["lead_creation", "post_enrichment", "pre_enrichment", "viability_gate"],
  },
  lead_enrichment_queue: {
    enrichment_type: ["duplicate_check", "osint_profile", "phone_validation", "property_match", "skip_trace"],
  },
  lead_imports: {
    status: ["completed", "failed", "pending", "processing"],
  },
  lead_magnets: {
    status: ["archived", "draft", "published"],
  },
  lead_score_history: {
    urgency_level: ["cold", "cool", "hot", "warm"],
  },
  lead_scraping_jobs: {
    status: ["cancelled", "completed", "failed", "pending", "running"],
  },
  lead_scraping_keywords: {
    keyword_type: ["buyer", "expired", "fsbo", "investor", "motivated_seller"],
  },
  lead_scraping_markets: {
    territory_scope: ["agent", "brokerage", "team"],
  },
  lead_sla_tracking: {
    sla_type: ["appointment", "assignment", "first_contact", "qualification"],
  },
  leaderboard_rankings: {
    metric_type: ["points", "referrals", "revenue", "transactions"],
    scope: ["agent", "brokerage", "team"],
  },
  leads: {
    lead_temperature: ["cold", "hot", "warm"],
    lender_status: ["cash", "needs_pre_approval", "pre_approved", "unknown"],
    lifecycle_state: ["appointment", "assigned", "consented", "isa_qualifying", "long_term_nurture", "raw", "representation", "unconsented"],
    reengagement_status: ["active", "completed", "handed_to_sphere", "long_horizon", "none", "opted_out", "paused", "stopped"],
    source_family: ["contact_direct", "lead", "raw"],
    source_origin: ["brokerage", "platform"],
    urgency_level: ["cold", "cool", "hot", "warm"],
  },
  learning_assignments: {
    status: ["completed", "dismissed", "open", "superseded", "viewed"],
  },
  learning_module_channel_publications: {
    channel: ["article", "blog", "email", "newsletter", "podcast", "portal_lesson", "quiz", "social", "video"],
    status: ["failed", "published", "queued", "revoked"],
  },
  learning_modules: {
    status: ["archived", "draft", "pending_review", "published", "rejected"],
  },
  lender_applications: {
    status: ["active", "approved", "cancelled", "closed", "denied", "docs_needed", "pending", "pre_approval", "pre_approved", "processing", "underwriting"],
  },
  license_verifications: {
    verification_method: ["document_ai", "manual", "nipr_api", "state_portal_manual", "state_registry_scrape"],
    verification_result: ["failed", "inconclusive", "passed"],
  },
  lifecycle_events: {
    source: ["cron", "system", "ui", "webhook"],
  },
  lifecycle_promo_policy: {
    event_type: ["coming_soon", "just_listed", "just_sold", "open_house_announce", "open_house_reminder", "price_reduction", "under_contract"],
    mail_postcard_size: ["4x6", "6x9"],
    mail_target_audience: ["farm", "farm+sphere", "sphere"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  lifetime_customer_npv_scores: {
    tier: ["bronze", "dormant", "gold", "platinum", "silver"],
  },
  lifetime_customer_touchpoints: {
    channel: ["call", "direct_mail", "email", "in_app", "push", "sms", "video"],
    status: ["cancelled", "delivered", "failed", "pending_review", "scheduled", "sent", "skipped"],
    touchpoint_type: ["annual_home_value_report", "birthday", "call", "custom", "email", "holiday", "home_anniversary", "market_update", "new_listing_match", "open_house_invite", "post_close_30_day", "post_close_3_day", "post_close_6_month", "price_drop_alert", "quarterly_home_value_report", "referral_request", "sms", "thank_you", "video"],
  },
  listing_agreements: {
    adjustment_type: ["charity_donation", "custom", "first_responder", "military", "relocation", "repeat_client"],
    adjustment_value_type: ["flat", "percent"],
    agreement_type: ["buyer_representation", "dual_agency", "listing", "representation"],
    esign_status: ["declined", "fully_signed", "partially_signed", "pending", "sent", "voided"],
    upload_mode: ["manual_upload", "provider_pull"],
  },
  listing_engagement: {
    engagement_type: ["inquiry", "save", "showing", "view"],
  },
  listing_health_interventions: {
    severity: ["critical", "high", "low", "medium"],
  },
  listing_health_scores: {
    risk_level: ["at_risk", "critical", "healthy", "watch"],
  },
  listing_landing_pages: {
    status: ["archived", "draft", "pending", "published"],
  },
  listing_marketing_packages: {
    package_type: ["basic", "luxury", "premium", "standard"],
  },
  listing_media: {
    media_type: ["document", "floorplan", "graphic", "photo", "reel", "story", "video", "virtual_tour"],
    usage_intent: ["both", "mls", "public_marketing"],
  },
  listing_packet_jobs: {
    job_type: ["full_packet", "mls_packet", "offer_packet", "open_house_booklet", "seller_packet", "social_packet"],
    status: ["completed", "failed", "pending", "processing", "queued"],
  },
  listing_presentations: {
    status: ["abandoned", "converted", "draft", "presented", "ready"],
  },
  listing_promo_videos: {
    event_type: ["coming_soon", "just_listed", "just_sold", "open_house_announce", "open_house_reminder", "price_reduction", "under_contract"],
    status: ["failed", "queued", "remotion_pending", "rendering", "social_drafted", "suppressed"],
  },
  listing_syndication_tracking: {
    syndication_status: ["active", "failed", "pending", "removed"],
  },
  listing_task_templates: {
    owner_role: ["admin", "agent", "photographer", "seller", "tc", "vendor"],
    priority: ["high", "low", "medium"],
  },
  listings: {
    lifecycle_stage: ["AGENT_CONSULTATION", "APPOINTMENT_SET", "APPRAISAL", "CLOSED", "CLOSING_PREP", "CMA_GENERATION", "COMING_SOON_ACTIVE", "COMING_SOON_PREP", "FINANCING", "INSPECTION", "LEAD", "LEAD_ASSIGNED", "LIFETIME_CUSTOMER", "LISTING_AGREEMENT_INITIATED", "LISTING_AGREEMENT_SIGNED", "LISTING_CANCELLED", "LISTING_EXPIRED", "LISTING_PRESENTATION_CREATED", "MEDIA_APPROVED", "MEDIA_CAPTURE", "MLS_ACTIVE", "MLS_DATE_CONFIRMED", "MLS_READY", "NEGOTIATION", "OFFERS_RECEIVED", "OPEN_HOUSE_EVENT", "OPEN_HOUSE_MARKETING", "PRESENTATION_DRIP_PREP", "PRESENTATION_VIDEO_GENERATED", "REPAIRS_IN_PROGRESS", "SELLER_DECISION", "SELLER_DECLINED", "SHOWINGS_ACTIVE", "UNDER_CONTRACT"],
    property_type: ["commercial", "condo", "land", "multi_family", "other", "single_family", "townhouse"],
    status: ["active", "cancelled", "coming_soon", "draft", "expired", "listing_signed", "off_market", "pending", "sold", "withdrawn"],
  },
  long_form_videos: {
    status: ["editing", "planning", "published", "recording"],
  },
  mail_response_tracking: {
    response_type: ["appointment", "call", "form_submit", "landing_visit", "qr_scan", "reply"],
  },
  managed_agent_sessions: {
    entity_type: ["brokerage", "contact", "listing", "transaction"],
    status: ["error", "idle", "running", "terminated"],
  },
  managed_agents: {
    agent_kind: ["ads_manager", "ai_isa", "asset_manager", "campaign_orchestrator", "compliance_officer", "cron_manager", "data_steward", "deal_coordinator", "finance_manager", "listing_concierge", "marketing_agent", "recruiting_manager", "shopping_agent", "sphere_of_influence"],
  },
  manager_signals: {
    status: ["consumed", "expired", "open"],
  },
  market_data: {
    dom_trend: ["decreasing", "increasing", "stable"],
    market_type: ["balanced", "buyers", "sellers"],
  },
  market_data_sources: {
    source_type: ["batchdata", "cma_aggregate", "housecanary", "idx_broker", "manual_import", "mls_feed", "osint_scrape"],
  },
  market_insights: {
    dom_trend: ["decreasing", "increasing", "stable"],
    inventory_level: ["balanced", "oversupplied", "tight"],
    market_type: ["balanced", "buyers", "sellers"],
    price_trend: ["down", "flat", "up"],
  },
  marketing_agent_actions: {
    action_type: ["approve_prelisting_delivery", "cancel_blog_cadence_tick", "cancel_direct_mail_send", "defer_newsletter_campaign", "flag_design_for_review", "flag_listing_for_review", "just_sold_campaign", "mark_topic_used", "omnipresence_topic_fanout", "promote_new_listing", "reallocate_lead_sources", "regenerate_faq", "retry_direct_mail_design", "retry_listing_promo_render", "stage_newsletter_draft", "start_prelisting_drip", "verify_lead_address"],
    status: ["approved", "executing", "failed", "proposed", "skipped", "succeeded"],
  },
  marketing_asset_qr_links: {
    placement_type: ["flyer", "listing_asset", "mailer", "podcast_landing", "social_landing", "video_endcard"],
  },
  marketing_assets: {
    approval_status: ["approved", "pending", "rejected"],
    asset_type: ["ad_creative", "blog", "graphic", "image", "mailer", "newsletter", "podcast", "qr", "script", "snippet", "social_post", "template", "video"],
    regen_status: ["failed", "processing", "requested"],
    visibility_scope: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  marketing_attribution_credits: {
    attribution_model: ["first_touch", "last_touch", "linear", "time_decay"],
  },
  marketing_campaign_tasks: {
    status: ["cancelled", "completed", "in_progress", "pending"],
  },
  marketing_campaign_touchpoints: {
    channel: ["blog", "direct_mail", "email", "newsletter", "phone", "podcast", "portal", "qr_scan", "sms", "social", "video"],
    source: ["launch", "manual", "retarget", "sequence", "trigger"],
    status: ["bounced", "clicked", "converted", "delivered", "failed", "opened", "queued", "sent"],
  },
  marketing_campaign_triggers: {
    trigger_type: ["buyer_stage", "lifecycle_event", "milestone", "sphere_anniversary"],
  },
  marketing_campaigns: {
    campaign_type: ["ad", "direct_mail", "listing_bundle", "newsletter", "omni", "podcast", "seo", "social", "video"],
    compliance_status: ["blocked", "needs_review", "passed", "pending"],
    status: ["approved", "archived", "draft", "ended", "failed", "live", "paused", "pending_review", "scheduled"],
    visibility_scope: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  marketing_channel_settings: {
    channel_type: ["facebook", "instagram", "linkedin", "newsletter", "podcast", "x", "youtube"],
  },
  message_provider_logs: {
    channel: ["ai_social_dm", "direct_mail", "email", "in_app", "portal", "sms", "video", "voice"],
    direction: ["inbound", "outbound"],
  },
  message_threads: {
    channel: ["direct_mail", "email", "in_app", "sms", "voice"],
  },
  model_retraining_log: {
    status: ["completed", "failed", "pending", "running"],
    trigger_type: ["approval_rate_threshold", "manual", "negative_spike", "weekly_batch"],
  },
  negotiation_strategies: {
    agent_disposition: ["did_already", "did_now", "dismissed", "let_ai_do_it"],
    generated_by: ["ai", "kernel", "manual"],
    outcome: ["accepted", "closed", "countered", "lost", "rejected", "withdrawn"],
    recommended_action: ["accept", "counter", "reject", "request_inspection_credit", "wait", "walk"],
    side: ["buyer", "seller"],
    status: ["accepted_by_agent", "dismissed", "open", "outcome_recorded", "superseded"],
  },
  neighbor_notification_campaigns: {
    status: ["approved", "awaiting_seller_permission", "cancelled", "draft", "sending", "sent"],
  },
  neighbor_notification_recipients: {
    status: ["delivered", "identified", "queued", "responded", "sent", "suppressed", "undeliverable"],
  },
  neighborhood_data_sources: {
    source_type: ["attom", "census", "custom", "housecanary", "walkscore"],
  },
  neighborhood_reports: {
    market_trend: ["cold", "cooling", "hot", "warm"],
  },
  newsletter_brokers_templates: {
    approval_status: ["approved", "draft", "pending_review", "rejected"],
  },
  newsletter_cadence_policy: {
    cadence: ["biweekly", "monthly", "off", "weekly"],
    scope_type: ["agent", "brokerage", "team"],
  },
  newsletter_campaigns: {
    approval_status: ["approved", "draft", "pending_review", "rejected"],
    status: ["deferred", "draft", "scheduled", "sending", "sent"],
  },
  newsletter_scheduled_sends: {
    send_status: ["cancelled", "failed", "scheduled", "sending", "sent"],
  },
  newsletter_sections: {
    section_type: ["agent_intro", "community_eats", "cta", "custom", "local_event", "local_news", "market_update", "mortgage_rates", "neighborhood_spotlight", "new_listings", "property_highlight", "testimonial", "tips"],
  },
  outcome_reconciliations: {
    channel: ["direct_mail", "email", "sms", "social", "video"],
    verdict: ["confirmed", "contradicted", "pending", "unverifiable"],
  },
  newsletter_sends: {
    status: ["bounced", "clicked", "failed", "opened", "queued", "sent", "suppressed"],
  },
  newsletter_subscribers: {
    source: ["auto_contact", "auto_lead_capture", "auto_lifetime", "form", "import", "manual", "open_house", "portal", "qr_scan"],
    status: ["bounced", "complained", "subscribed", "unsubscribed"],
  },
  newsletter_teasers: {
    status: ["archived", "draft", "queued", "sent"],
  },
  newsletter_templates: {
    scope: ["agent", "brokerage", "team"],
  },
  newsletter_video_renders: {
    status: ["completed", "failed", "queued", "rendering", "suppressed"],
  },
  notification_rules: {
    notification_type: ["email", "push", "sms"],
    recipient_role: ["TC", "admin", "agent", "broker", "closing_attorney", "compliance_officer", "title_agent"],
    trigger_event: ["appraisal_due", "authority_blocked", "business_card_approved", "business_card_uploaded", "buyer_disengaged", "buyer_verified", "cd_due", "cd_received", "closing_scheduled", "compliance_violation", "consent_received", "contact_captured", "contact_created", "contact_dedup_merged", "contact_enrichment_completed", "contact_enrichment_failed", "contact_enrichment_queued", "contact_scored", "contract_signed", "deal_closed", "deal_on_hold", "decision_pending", "document_received", "document_requested", "enrichment_completed", "enrichment_failed", "financing_due", "form_submission_received", "ghost_lead_detected", "inspection_due", "isa_appointment_scheduled", "isa_max_touches_reached", "isa_outreach_paused", "isa_outreach_sent", "isa_qualification_started", "isa_qualified_lead", "isa_reply_received", "lead_assigned", "lead_assignment_failed", "lead_captured", "lead_claimed", "lead_converted_to_contact", "lead_import_completed", "lead_ready_for_assignment", "lead_scored", "lead_sla_breached", "lifetime_customer", "listing_published", "message_from_contact", "message_needs_response", "new_lead", "offer_eligible", "offer_received", "offer_submitted", "price_determined", "qr_scan_received", "raw_lead_viability_failed", "raw_lead_viability_passed", "ready_to_close", "reengagement_completed", "reengagement_started", "referral_received", "showing_completed", "showing_scheduled", "stale_lead_alert", "task_assigned", "task_completed", "task_due", "task_overdue", "tour_eligible", "tour_scheduled", "walkthrough_due", "website_visitor_identified"],
  },
  notifications: {
    channel: ["email", "in_app", "sms"],
    priority: ["critical", "high", "low", "medium"],
  },
  objection_training_sessions: {
    difficulty: ["easy", "hard", "medium"],
    status: ["abandoned", "active", "completed"],
  },
  objection_training_turns: {
    speaker: ["agent", "prospect"],
  },
  offer_strategy_templates: {
    market_condition: ["balanced", "buyers_market", "cooling", "hot", "sellers_market"],
    risk_level: ["high", "low", "medium"],
    strategy_type: ["aggressive", "cash_equivalent", "conservative", "creative", "standard"],
  },
  offers: {
    ai_extraction_status: ["completed", "extracting", "failed", "manual", "pending"],
    commission_disclosure_method: ["click_through", "docusign", "dotloop", "wet_signature"],
    disclosed_commission_payer: ["buyer", "either", "seller", "split"],
    esign_provider: ["authentisign", "docusign", "dotloop", "in_app", "skyslope"],
    esign_status: ["declined", "fully_signed", "partially_signed", "pending", "sent", "voided"],
    form_source: ["authentisign", "docusign", "dotloop", "in_app", "manual", "portal_upload", "skyslope"],
    offer_type: ["backup", "counter", "multiple_counter", "standard"],
    seller_response_type: ["accepted", "countered", "rejected"],
  },
  onboarding_steps: {
    category: ["certification", "compliance", "practice", "system_setup", "training"],
  },
  open_house_attendees: {
    instant_greeting_channel: ["email", "sms"],
    interest_level: ["cold", "hot", "no_interest", "warm"],
  },
  open_house_events: {
    event_type: ["broker_open", "open_house", "virtual_open_house"],
    status: ["active", "cancelled", "completed", "marketing", "scheduled"],
  },
  open_house_feedback: {
    price_opinion: ["good_value", "priced_right", "too_high"],
  },
  open_house_invitations: {
    channel: ["both", "email", "in_app", "sms"],
    invitation_type: ["broker_preview", "open_house", "virtual_open_house"],
    rsvp_response: ["maybe", "no", "no_response", "yes"],
  },
  open_house_rsvp_tracking: {
    rsvp_status: ["attended", "invited", "maybe", "no", "no_show", "yes"],
    source: ["ai_reception", "email", "qr_code", "sms", "walk_in"],
  },
  orchestrator_tasks: {
    status: ["cancelled", "completed", "failed", "pending", "running"],
  },
  outbound_message_compliance_log: {
    channel: ["call", "email", "sms"],
    decision: ["allowed", "blocked", "warning_logged"],
  },
  pattern_adoptions: {
    status: ["applied", "failed", "reverted"],
  },
  pattern_detections: {
    entity_type: ["contact", "listing"],
    status: ["acknowledged", "acted_on", "active", "dismissed", "expired"],
  },
  pattern_predictions: {
    entity_type: ["contact", "listing"],
    outcome: ["correct", "inconclusive", "incorrect", "pending"],
  },
  phone_number_events: {
    event_type: ["failed", "manually_added", "ported_in", "purchased", "released", "webhooks_bound"],
  },
  photo_enhancement_jobs: {
    status: ["cancelled", "completed", "failed", "processing", "queued"],
  },
  plan_limits: {
    metric: ["active_transactions", "active_users", "ai_tokens_monthly", "avatars_created", "contacts_count", "emails_sent", "live_assistant_minutes", "live_assistant_sessions", "live_avatar_minutes", "live_avatar_sessions", "llm_calls", "sms_sent", "storage_gb", "tts_characters", "ai_voice_minutes", "video_minutes", "voice_clones_created"],
    plan_tier: ["brokerage", "multi_location", "solo_agent", "team"],
  },
  platform_affiliates: {
    status: ["active", "ended", "paused"],
  },
  platform_content_topics: {
    source: ["competitor", "manual", "trend"],
    status: ["dismissed", "new", "used"],
  },
  platform_coupons: {
    applies_to_tier: ["brokerage", "multi_location", "solo_agent", "team"],
    duration: ["forever", "once", "repeating"],
  },
  platform_credentials: {
    owner_type: ["agent", "brokerage", "contact", "platform", "team", "vendor"],
    platform: ["authentisign", "bandwidth", "brokermint", "buffer", "did", "docusign", "dotloop", "facebook", "followupboss", "formsimplicity", "gmail", "gohighlevel", "google_calendar", "google_flow", "hubspot", "idxbroker", "instagram", "linkedin", "listhub", "lob", "lofty", "mailgun", "mls", "mls_direct", "opcity", "outlook", "pexels", "plaid", "platform_quickbooks", "platform_social_facebook", "platform_social_instagram", "platform_social_linkedin", "platform_social_tiktok", "platform_social_x", "platform_social_youtube", "platform_zoom", "plivo", "postmark", "quickbooks", "realtor_com", "resend", "sendgrid", "showingtime", "sinch", "skyslope", "stripe", "telnyx", "twilio", "twilio_a2p", "twilio_byo", "twilio_subaccount", "zillow", "zoom"],
    scope: ["agent", "brokerage", "team"],
    test_status: ["fail", "pass", "pending"],
  },
  platform_impersonation_sessions: {
    mode: ["full", "read_only"],
  },
  platform_prospects: {
    role_interest: ["brokerage", "multi_location", "solo_agent", "team", "unknown"],
    status: ["contacted", "converted", "lost", "new", "trial"],
  },
  platform_reception_calls: {
    status: ["completed", "in_progress", "transferred"],
  },
  platform_role_capability_overrides: {
    access: ["read", "write"],
    role: ["admin", "marketing", "support"],
  },
  platform_sentinel_actions: {
    draft_channel: ["call", "email", "none", "sms"],
    kind: ["connection_expiry", "demo_followup", "dunning_risk", "engagement_risk", "growth_opportunity", "support_sla"],
    severity: ["critical", "info", "warn"],
    status: ["approved", "dismissed", "proposed", "sent"],
  },
  platform_social_accounts: {
    platform: ["facebook", "instagram", "linkedin", "tiktok", "x", "youtube"],
    status: ["connected", "disconnected", "error", "pending"],
  },
  platform_social_drafts: {
    channel: ["facebook", "instagram", "linkedin", "x"],
    media_type: ["post", "video"],
    status: ["approved", "discarded", "draft", "posted"],
  },
  platform_suppression_list: {
    reason: ["explicit_opt_out", "federal_dnc", "litigator", "manual_admin", "spam_complaint", "tcpa_violation"],
  },
  playbooks: {
    status: ["active", "archived", "draft"],
  },
  podcast_analytics_events: {
    event_type: ["complete", "cta_click", "download", "pause", "play", "share", "subscribe"],
  },
  podcast_auto_runs: {
    status: ["failed", "generating", "published", "queued", "rendered", "skipped"],
  },
  podcast_distribution_channels: {
    channel_name: ["apple_podcasts", "other", "rss", "spotify", "youtube_music"],
  },
  podcast_distribution_log: {
    distribution_status: ["failed", "published", "queued", "skipped"],
  },
  podcast_episode_presets: {
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  podcast_episodes: {
    status: ["completed", "draft", "failed", "generating", "processing", "published", "scheduled"],
  },
  podcast_segments: {
    segment_type: ["ad_break", "body", "cta", "intro", "outro", "qa"],
  },
  podcast_templates: {
    template_type: ["educational", "interview", "listing_spotlight", "market_update", "solo"],
  },
  policy_decisions: {
    decision: ["amber", "green", "red"],
  },
  portal_contact_invites: {
    portal_view: ["buyer", "lifetime", "seller"],
    status: ["accepted", "expired", "pending", "revoked", "sent"],
  },
  portal_event_stream: {
    agent_action_status: ["completed_ai", "completed_executed", "completed_manual", "dismissed", "open"],
    severity: ["celebration", "critical", "high", "normal"],
  },
  portal_push_presets: {
    priority: ["high", "low", "normal", "urgent"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  predictive_listing_actions: {
    action_type: ["auto_touch", "manual_consult", "manual_dismiss", "manual_nurture", "manual_touch"],
    channel: ["direct_mail", "email", "sms"],
    status: ["blocked", "cancelled", "failed", "pending_review", "queued", "sent"],
  },
  presentation_sections: {
    channel: ["both", "email", "portal"],
    status: ["delivered", "failed", "pending", "scheduled", "viewed"],
  },
  price_predictions: {
    trend_direction: ["down", "flat", "up"],
  },
  price_trend_alerts: {
    alert_type: ["comparable_sold_lower", "days_on_market_warning", "declining_showings", "market_shift", "no_offers", "price_reduction_recommended", "price_too_high"],
    severity: ["critical", "high", "low", "medium"],
  },
  pricing_history: {
    price_type: ["list", "prediction", "reduction", "sold"],
  },
  privacy_acceptances: {
    policy_type: ["ccpa_notice", "cookie_policy", "gdpr_notice", "privacy_policy", "tcpa_consent", "terms_of_service"],
  },
  proactive_interventions: {
    severity: ["critical", "high", "low", "medium"],
  },
  prohibited_phrases: {
    severity: ["critical", "info", "warning"],
  },
  property_alert_delivery_log: {
    run_triggered_by: ["agent_manual", "cron", "system"],
  },
  property_alert_results: {
    buyer_reaction: ["interested", "not_interested", "scheduled_showing", "very_interested"],
  },
  property_alerts: {
    frequency: ["daily", "instant", "paused", "twice_daily", "weekly"],
    paused_by: ["agent", "buyer", "system"],
    source: ["agent_created", "buyer_adjusted", "system_generated", "text_conversation", "voice_conversation"],
  },
  property_interactions: {
    interaction_type: ["favorite", "inquiry", "offer", "price_alert_click", "save", "share", "tour_request", "view"],
  },
  property_interests: {
    alert_frequency: ["daily", "instant", "paused", "twice_daily", "weekly"],
  },
  property_smart_insights: {
    market_position: ["above_average", "average", "below_average", "hot", "slow"],
  },
  property_upgrades: {
    status: ["approved", "completed", "declined", "suggested"],
  },
  provider_overrides: {
    provider_type: ["accounting", "ai", "ai_voice", "avatar", "calendar", "crm", "crm_sync", "direct_mail", "email", "enrichment", "esign", "idx", "payment", "phone", "scraper", "showing", "sms", "social", "transaction", "video", "voice_clone"],
    scope_type: ["admin", "brokerage", "superadmin", "team", "user"],
  },
  push_notification_queue: {
    status: ["cancelled", "delivered", "delivering", "failed", "pending"],
  },
  qr_codes: {
    destination_type: ["anniversary_video", "book_meeting", "cma_form", "landing_page", "listing_detail", "other", "podcast_episode", "video_avatar_tour"],
    purpose: ["business_card", "campaign", "event", "general", "lead_capture", "lead_magnet", "listing", "listing_inquiry", "open_house"],
  },
  quickbooks_sync_log: {
    direction: ["bidirectional", "pull", "push"],
    status: ["completed", "failed", "in_progress", "partial"],
  },
  raw_scraped_leads: {
    source_family: ["contact_direct", "lead", "raw"],
    source_origin: ["brokerage", "platform"],
  },
  recruiting_costs: {
    cost_type: ["onboarding", "other", "recruiting_fee", "signing_bonus", "training"],
  },
  recruits: {
    status: ["contacted", "declined", "interviewing", "joined", "offer_extended", "prospect"],
  },
  referral_partners: {
    agreement_type: ["informal", "one_way", "paid", "reciprocal"],
    partner_type: ["attorney", "contractor", "home_inspector", "insurance_agent", "mortgage_broker", "other", "property_manager", "real_estate_agent", "title_company"],
  },
  referral_sources: {
    source_type: ["campaign", "other", "partner", "past_client", "sphere"],
  },
  referrals: {
    status: ["assigned", "closed", "contacted", "lost", "qualified", "received", "under_contract"],
  },
  reg_change_observations: {
    severity_tier: ["advisory", "binding", "informational"],
  },
  remotion_composition_renders: {
    render_status: ["cancelled", "failed", "queued", "rendering", "succeeded"],
    requested_via: ["ad_creator", "api", "asset_manager", "cron", "manual"],
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  remotion_compositions: {
    category: ["affordability", "agent_avatar", "coming_soon", "explainer", "lead_magnet", "listing", "market_update", "neighborhood", "newsletter", "open_house", "postcard", "presentation", "testimonial", "thumbnail"],
    orientation: ["horizontal", "postcard", "square", "static_card", "vertical"],
  },
  repurpose_pipelines: {
    source_type: ["blog", "blog_post", "newsletter", "podcast", "podcast_episode", "script", "social_post", "video", "video_project", "video_url"],
    visibility_scope: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  repurposed_content_log: {
    approval_status: ["approved", "draft", "pending_review", "rejected"],
    status: ["failed", "generated", "published", "scheduled"],
  },
  revenue_protection_snapshots: {
    snapshot_type: ["daily", "lifetime", "monthly", "quarterly", "weekly", "ytd"],
  },
  scheduled_touchpoints: {
    status: ["completed", "failed", "scheduled", "sent", "skipped"],
  },
  scripts: {
    status: ["approved", "archived", "draft"],
    // m429. The AUDIENCE, deliberately separate from `status` (which is the
    // editorial lifecycle above): private = the author's own, brokerage = shared
    // with the whole brokerage by the owner's viral rule, platform = the
    // catalogue, tied to brokerage_id IS NULL by a CHECK.
    visibility: ["brokerage", "platform", "private"],
  },
  self_heal_events: {
    domain: ["connector", "data_flow"],
    outcome: ["dismissed", "escalated", "failed", "healed", "resolved"],
  },
  seller_stage_coaching: {
    persona: ["analytical", "emotional", "indecisive", "investor", "motivated", "skeptical"],
  },
  seo_keywords: {
    keyword_type: ["local", "long_tail", "primary", "question", "secondary"],
    search_intent: ["commercial", "informational", "navigational", "transactional"],
    visibility_scope: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  sequence_enrollments: {
    ab_variant: ["A", "B"],
    status: ["active", "authority_blocked", "cancelled", "completed", "converted", "paused", "unenrolled", "unsubscribed"],
  },
  sequence_step_executions: {
    status: ["authority_blocked", "clicked", "delivered", "failed", "opened", "pending", "replied", "sent", "skipped"],
  },
  service_status: {
    current_status: ["degraded", "down", "healthy", "unknown"],
    service_category: ["accounting", "ai", "calendar", "database", "email", "esign", "payment", "scraper", "sms", "storage", "video", "voice"],
  },
  showing_communications: {
    communication_type: ["cancellation", "confirmation", "feedback", "reminder", "reschedule"],
    status: ["failed", "queued", "sent"],
  },
  showing_feedback: {
    buyer_interest_level: ["cold", "cool", "hot", "warm"],
    meets_buyer_needs: ["no", "partially", "yes"],
    offer_interest: ["no", "possible", "unlikely", "very_likely"],
    overall_impression: ["liked_it", "loved_it", "neutral", "not_interested"],
    price_opinion: ["good_value", "priced_right", "too_high"],
  },
  showing_requests: {
    status: ["approved", "cancelled", "denied", "needs_reschedule", "pending"],
  },
  showings: {
    access_method: ["agent_present", "key_at_office", "lockbox", "other", "smart_lock", "tenant_access"],
    buyer_interest_level: ["like_it", "love_it", "maybe", "no"],
    scheduling_method: ["email", "manual_call", "other", "self_book", "showingtime", "text"],
    sync_source: ["ai_scheduler", "manual", "other", "showingtime", "workflow_sequence"],
  },
  signature_requests: {
    request_status: ["cancelled", "completed", "expired", "partially_signed", "pending", "sent"],
  },
  smart_assistant_suggestions: {
    priority: ["high", "low", "medium"],
    status: ["accepted", "actioned", "dismissed", "executed", "ignored", "pending"],
  },
  sms_presets: {
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  social_cadence_policy: {
    cadence: ["biweekly", "monthly", "off", "weekly"],
    scope_type: ["agent", "brokerage", "team"],
  },
  social_media_accounts: {
    platform: ["facebook", "google_business", "instagram", "linkedin", "pinterest", "tiktok", "twitter", "whatsapp", "youtube"],
    scope: ["agent", "brokerage"],
  },
  social_post_presets: {
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  social_posts: {
    approval_status: ["approved", "pending", "rejected"],
    platform: ["all", "facebook", "google_business", "instagram", "linkedin", "pinterest", "tiktok", "twitter", "youtube"],
    post_type: ["carousel", "coming_soon", "custom", "just_sold", "market_update", "new_listing", "open_house_announcement", "open_house_recap", "open_house_reminder", "price_reduction"],
    status: ["cancelled", "draft", "failed", "published", "publishing", "scheduled"],
  },
  social_publish_log: {
    publish_status: ["cancelled", "failed", "published", "queued"],
  },
  state_appraiser_adjustment_rates: {
    rate_basis: ["pct_of_comp_price", "per_unit_dollars"],
  },
  state_protected_classes: {
    severity_default: ["critical", "high", "low", "medium"],
  },
  strategy_outcomes: {
    outcome: ["accepted", "countered", "rejected", "withdrawn"],
  },
  strategy_recommendations: {
    status: ["accepted", "modified", "pending", "rejected"],
  },
  studio_sessions: {
    status: ["commissioned", "failed", "partial", "planned"],
  },
  subscription_tiers: {
    tier_name: ["brokerage", "multi_location", "solo_agent", "team"],
  },
  subscriptions: {
    status: ["active", "cancelled", "past_due", "paused", "trialing"],
  },
  support_ticket_messages: {
    author_kind: ["staff", "tenant"],
  },
  support_tickets: {
    priority: ["high", "low", "medium", "urgent"],
    status: ["closed", "in_progress", "open", "resolved"],
  },
  system_health_checks: {
    status: ["degraded", "down", "error", "healthy", "timeout", "unknown"],
  },
  team_commission_profiles: {
    referral_type: ["flat", "percent"],
    residual_type: ["flat", "percent"],
    team_split_type: ["flat", "percent"],
  },
  team_earnings: {
    period_type: ["all_time", "mtd", "ytd"],
  },
  team_heatmap_snapshots: {
    activity_type: ["buyer", "closed", "lead", "listing"],
  },
  team_members: {
    role: ["buyers_agent", "lead", "member", "showing_agent", "support"],
    source_of_funds: ["agent", "brokerage"],
  },
  teams: {
    team_split_type: ["flat", "percent"],
  },
  template_marketplace: {
    visibility: ["brokerage_only", "global", "private"],
  },
  tenant_ai_teammates: {
    autonomy: ["approved_send", "autonomous", "draft_only"],
    status: ["active", "paused", "retired"],
  },
  tenant_custom_domains: {
    status: ["active", "error", "pending_dns", "removed", "verifying"],
  },
  tenant_safety_findings: {
    finding_type: ["cross_tenant_join_risk", "listing_missing_agreement", "rows_missing_brokerage_id", "table_missing_brokerage_id", "table_missing_rls_policy"],
    severity: ["critical", "high", "low", "medium"],
  },
  tenant_sso_connections: {
    provider_type: ["oidc", "saml"],
    status: ["active", "disabled", "error", "pending"],
  },
  tenant_webhook_deliveries: {
    status: ["dead", "delivered", "failed", "pending"],
  },
  title_company_users: {
    access_level: ["full", "read", "upload"],
  },
  title_orders: {
    status: ["cancelled", "clear", "completed", "exception", "in_progress", "issue", "ordered", "pending"],
  },
  tour_stops: {
    access_method: ["agent_present", "key_at_office", "lockbox", "other", "smart_lock", "tenant_access"],
    buyer_interest_level: ["like_it", "love_it", "maybe", "no"],
    scheduling_method: ["email", "manual_call", "other", "showingtime", "text"],
  },
  training_videos: {
    category: ["compliance", "custom", "isa_engine", "lead_management", "listing_workflow", "marketing", "mobile_app", "platform_tour", "portal", "them_first", "transaction"],
  },
  transaction_agent_roles: {
    role_type: ["buyer_agent", "co_agent", "primary", "referral_in", "referral_out", "seller_agent"],
  },
  transaction_commissions: {
    status: ["approved", "disputed", "paid", "pending"],
  },
  transaction_communications: {
    status: ["delivered", "draft", "failed", "sent"],
  },
  transaction_compliance_log: {
    status: ["fail", "needs_review", "pass", "pending", "waived"],
  },
  transaction_deadlines: {
    status: ["completed", "extended", "missed", "pending", "waived"],
  },
  transaction_documents: {
    status: ["approved", "missing", "pending_signature", "rejected", "requested", "under_review", "uploaded"],
  },
  transaction_inspections: {
    status: ["cancelled", "completed", "report_received", "scheduled"],
  },
  transaction_milestones: {
    status: ["cancelled", "completed", "overdue", "pending"],
  },
  transaction_pending_actions: {
    action_type: ["appraisal_not_ordered", "cda_missing", "clear_to_close_late", "contract_followup_check", "em_not_received", "financing_deadline_close", "hazard_insurance_unbound", "inspection_overdue", "inspection_window_closing", "lender_condition_stale", "title_commitment_late", "walkthrough_unscheduled", "wire_instructions_missing"],
    severity: ["high", "low", "medium", "urgent"],
    status: ["dismissed", "open", "resolved", "superseded"],
    suggested_recipient: ["agent", "buyer", "co_agent", "escrow", "inspector", "lender", "seller", "title"],
  },
  transaction_repair_negotiations: {
    priority: ["critical", "high", "low", "medium"],
    requested_by: ["buyer", "seller"],
    status: ["approved", "completed", "countered", "rejected", "requested", "withdrawn"],
  },
  transaction_tasks: {
    priority: ["critical", "high", "low", "medium"],
    status: ["cancelled", "completed", "in_progress", "pending"],
  },
  transaction_vendor_services: {
    // "bound" (m385) — the buyer's hazard policy is actually in force, which is
    // NOT the same as "approved" (client accepted a quote). A lender will not fund on the latter.
    status: ["approved", "bound", "cancelled", "completed", "in_progress", "ordered", "pending_approval", "quote_requested", "scheduled"],
  },
  transactions: {
    commission_final_source: ["cd_uploaded", "cda_signed"],
    deal_type: ["buyer", "dual", "seller"],
    source_family: ["contact_direct", "lead", "raw"],
    stage: ["APPRAISAL", "CLOSED", "CLOSING_PREP", "FINANCING_PENDING", "INSPECTION", "LOST", "UNDER_CONTRACT"],
    status: ["active", "archived", "clear_to_close", "closed", "funded", "lead", "lost", "pending", "qualifying", "under_contract"],
  },
  trend_alerts: {
    alert_type: ["budget_spike", "competitor_launch", "content_trend", "copy_trend", "creative_trend", "market_shift_prediction", "platform_shift"],
    severity: ["critical", "high", "low", "medium"],
  },
  trid_timeline: {
    compliance_status: ["at_risk", "closed", "compliant", "in_progress", "violation"],
  },
  usage_counters: {
    metric: ["active_transactions", "active_users", "ai_tokens_monthly", "avatars_created", "contacts_count", "emails_sent", "live_assistant_minutes", "live_assistant_sessions", "live_avatar_minutes", "live_avatar_sessions", "llm_calls", "sms_sent", "storage_gb", "tts_characters", "ai_voice_minutes", "video_minutes", "voice_clones_created"],
  },
  usage_logs: {
    usage_type: ["ai_call", "email", "scraper_call", "sms", "storage", "video", "voice_call"],
  },
  user_invitations: {
    status: ["accepted", "expired", "pending", "revoked"],
  },
  users: {
    platform_role: ["admin", "ai_isa_system", "marketing", "superadmin", "support"],
    user_type: ["admin", "agent", "broker", "broker_owner", "compliance_officer", "contact", "isa", "lender", "superadmin", "support", "system", "tc", "team_lead", "vendor"],
  },
  valuation_requests: {
    condition: ["excellent", "fair", "good", "poor"],
  },
  tenant_phone_numbers: {
    number_source: ["byoc_twilio", "ported"],
    scope_type: ["agent", "brokerage", "platform", "team"],
  },
  vendor_assignments: {
    assignment_type: ["cleaner", "contractor", "inspector", "insurance", "lender", "mover", "other", "photographer", "stager", "title"],
    status: ["cancelled", "completed", "confirmed", "in_progress", "pending"],
  },
  vendor_bookings: {
    request_origin: ["admin", "agent", "contact", "tc", "vendor"],
    status: ["booked", "cancelled", "completed", "confirmed", "no_show"],
  },
  vendor_contact_assignments: {
    scope: ["financial", "pii_basic", "pii_full", "transaction_docs"],
    status: ["active", "expired", "revoked"],
  },
  vendor_earnings: {
    status: ["available", "on_hold", "paid_out", "pending"],
  },
  vendor_invitations: {
    status: ["accepted", "declined", "expired", "pending", "revoked"],
  },
  vendor_invoices: {
    billed_to: ["brokerage", "contact", "vendor"],
    status: ["cancelled", "disputed", "draft", "overdue", "paid", "submitted", "viewed"],
  },
  vendor_jobs: {
    status: ["cancelled", "completed", "in_progress", "pending", "scheduled"],
  },
  vendor_marketplace_profiles: {
    category: ["api", "integration", "service", "tool"],
    payout_method: ["ach", "cash_app", "check", "manual", "stripe"],
    status: ["approved", "inactive", "pending", "suspended"],
  },
  vendor_messages: {
    counterparty_type: ["agent", "contact"],
    sender_type: ["agent", "contact", "vendor"],
  },
  vendor_payouts: {
    status: ["cancelled", "failed", "paid", "pending", "processing"],
  },
  vendor_plans: {
    billing_cycle: ["annual", "monthly"],
    status: ["active", "archived"],
  },
  vendor_subscriptions: {
    status: ["active", "canceled", "paused"],
  },
  vendor_tax_documents: {
    business_type: ["c_corporation", "individual_sole_proprietor", "llc", "other", "partnership", "s_corporation", "trust_estate"],
    status: ["expired", "missing", "on_file"],
    tin_type: ["ein", "ssn"],
  },
  vendor_transactions: {
    status: ["completed", "failed", "pending"],
    transaction_type: ["charge", "credit_usage", "payout", "refund"],
  },
  vendors: {
    access_level: ["brokerage_full_access", "team_full_access", "transaction_only"],
    category: ["3d_tour", "appliance_repair", "attorney", "cleaner", "contractor", "drone_pilot", "electrician", "estate_sale", "financial_advisor", "flooring", "garage_door", "handyman", "home_warranty", "hvac", "insurance", "interior_design", "inspector", "landscaping", "lender", "mover", "organizer", "other", "painter", "pest_control", "photographer", "plumber", "pool_service", "property_management", "refinance_lender", "roofer", "security", "smart_home", "solar", "stager", "tax_pro", "title", "videographer", "window_treatment"],
    status: ["active", "archived", "inactive", "pending"],
  },
  video_assets: {
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  video_engagement_events: {
    event_type: ["click", "complete", "cta_click", "lead_capture", "pause", "replay", "share", "view"],
  },
  video_scripts_library: {
    approval_status: ["approved", "draft", "pending_review", "rejected"],
    script_type: ["agent_intro", "buyer_education", "listing_presentation", "market_update", "property_tour"],
  },
  video_snippets: {
    approval_status: ["approved", "draft", "pending_review", "rejected"],
  },
  video_streaming_status: {
    stream_status: ["failed", "pending", "preview_ready", "processing", "ready"],
  },
  voice_calls: {
    call_type: ["agent_call", "ai_isa_call", "ai_inbound", "warm_transfer", "zoom_meeting"],
    direction: ["inbound", "outbound"],
    outcome: ["appointment_set", "authority_blocked", "busy", "callback_requested", "canceled", "completed", "failed", "no_answer", "not_interested", "opt_out", "transferred", "voicemail", "voicemail_left", "warm_bridge_missed", "warm_bridge_ringing", "warm_transferred"],
    sentiment: ["negative", "neutral", "positive"],
    status: ["blocked", "completed", "failed", "in_progress", "initiated", "no_answer", "ringing", "voicemail"],
  },
  voice_clone_training: {
    status: ["completed", "failed", "processing", "queued"],
  },
  voice_commands: {
    command_type: ["check_compliance", "create_task", "dictate_note", "get_briefing", "log_activity", "lookup_contact", "navigate", "pull_report", "schedule_showing", "send_message", "unknown", "update_lead"],
    source: ["mobile", "pwa", "voice_call", "web"],
  },
  voicedrop_presets: {
    scope_type: ["agent", "brokerage", "multi_location", "platform", "team"],
  },
  wealth_advisor_recommendations: {
    opportunity_type: ["cash_out_refi", "downsize_and_bank_equity", "equity_milestone", "heloc_for_investment", "refinance_opportunity", "sell_and_1031_exchange"],
    status: ["converted", "dismissed", "open", "presented", "reviewed", "stale"],
  },
  workflow_intake_sessions: {
    intake_type: ["listing", "offer"],
    status: ["abandoned", "drafted", "in_progress", "ready_to_draft"],
  },
  workflow_run_steps: {
    status: ["done", "failed", "needs_approval", "pending", "running", "skipped"],
  },
  workflow_runs: {
    status: ["cancelled", "completed", "failed", "paused", "running"],
  },
}
