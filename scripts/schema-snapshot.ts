/**
 * scripts/schema-snapshot.ts
 *
 * GENERATED from the live Postgres schema (public). The schema-drift guard checks the
 * codebase's column references against this snapshot so the "code references a column the
 * table doesn't have → query silently errors" bug class (which broke buyer matching) can't
 * come back.
 *
 * REGENERATE when a guarded table's columns change:
 *   select table_name, json_agg(column_name order by column_name) as cols
 *   from information_schema.columns where table_schema='public'
 *   and table_name = ANY(ARRAY[...guarded tables...]) group by table_name;
 *
 * Last synced: 2026-06-09.
 */
export const SCHEMA_SNAPSHOT: Record<string, string[]> = {
  contacts: [
    "age_range", "agent_id", "ai_autopilot_level", "ai_isa_enabled", "ai_outreach_paused",
    "brokerage_id", "budget_max", "budget_min", "buyer_stage", "call_stop_flag",
    "campaign_attribution_id", "city", "compliance_officer_id", "confidence_score", "contact_id",
    "contact_persona", "contact_type", "contact_user_id", "cost_per_record", "court_records",
    "created_at", "data_source", "deleted_at", "direct_mail_opt_out", "dl_image_url", "dnc_status",
    "education_level", "email", "email_opt_out", "email_unsubscribed", "email_unsubscribed_at",
    "email_verification_date", "email_verified", "embed_widget_id", "engagement_score",
    "enriched_at", "enrichment_confidence", "enrichment_profile", "enrichment_source",
    "equity_estimate", "facebook_url", "first_name", "funds_max_purchase", "funds_source_type",
    "gender", "ghl_contact_id", "home_owner_status", "home_value_estimate", "household_income",
    "id", "instagram_url", "intent_score", "isa_handoff_at", "isa_handoff_brief",
    "isa_qualification_score", "isa_reengage_allowed", "isa_reengage_marked_by",
    "isa_reengage_set_at", "last_contacted_at", "last_enriched_at", "last_life_change_check",
    "last_life_event_detected", "last_name", "last_pls_scored_at",
    "last_scored_at", "lead_temperature", "legal_first_name", "legal_last_name",
    "legal_middle_name", "legal_name_source", "legal_name_verified_at", "lender_status",
    "length_of_residence", "life_events", "lifecycle_state", "linkedin_url", "mailing_address",
    "mailing_address_source", "mailing_address_verified", "mailing_address_verified_at",
    "marital_status", "metadata", "motivation_confidence", "motivation_type", "notes",
    "occupation", "opt_out_channels", "opt_out_reason", "opt_out_source", "opted_out_at",
    "peopledata_id", "phone", "phone_digits", "phone_opt_out", "phone_status", "phone_type",
    "phone_validated_at", "phone_verification_date", "phone_verified", "preferred_channel",
    "privacy_anonymized_at", "privacy_anonymized_reason", "property_records", "public_records",
    "qualification_summary", "referral_potential", "sms_opt_out", "sms_unsubscribed",
    "sms_unsubscribed_at", "social_handles", "source", "source_agent_id", "source_channel",
    "source_family", "source_subtype", "state", "status", "tc_user_id", "tcpa_consent",
    "tcpa_consent_at", "tcpa_consent_date", "tcpa_consent_ip", "tcpa_consent_source",
    "tcpa_consent_text", "tcpa_marked_at", "tcpa_marked_by", "team_id", "timeline",
    "twitter_url", "updated_at", "urgency_level", "user_id", "video_opt_out", "zip_code",
  ],
  property_preferences: [
    "agent_id", "brokerage_id", "confidence_score", "contact_id", "created_at", "id",
    "inferred_baths_min", "inferred_beds_min", "inferred_cities", "inferred_deal_breakers",
    "inferred_max_price", "inferred_min_price", "inferred_must_have_features",
    "inferred_property_types", "inferred_zip_codes", "last_calculated_at", "model_version",
    "preferred_price_max", "preferred_price_min", "signals_processed", "updated_at",
  ],
  listings: [
    "address", "agent_id", "bathrooms", "bedrooms", "brokerage_id", "city", "commission_rate",
    "contact_id", "created_at", "created_via", "deleted_at", "dotloop_loop_id", "expiration_date",
    "go_live_confirmed_at", "go_live_date", "id", "lifecycle_stage", "list_price",
    "listing_agent_email", "listing_agent_name", "listing_date", "marketing_budget",
    "marketing_tier_id", "metadata", "mls_link", "mls_number", "open_house_event_date",
    "open_house_marketing_date", "property_type", "public_remarks", "seller_contact_id", "showing_count",
    "showing_instructions", "sqft", "stage_entered_at", "stage_updated_at", "state", "status",
    "team_id", "transaction_provider_ref", "updated_at", "zip",
  ],
  property_matches: [
    "ai_generated", "brokerage_id", "contact_id", "created_at", "generated_at", "id",
    "match_reasons", "match_score", "potential_concerns", "priority_factors", "property_id",
    "recommended_actions", "user_feedback",
  ],
  saved_properties: [
    "added_to_tour", "ai_match_score", "bathrooms", "bedrooms", "brokerage_id", "city",
    "contact_id", "dismissed", "dismissed_reason", "external_property_id", "id", "list_price",
    "listing_id", "listing_url", "match_reasons", "mls_number", "notes", "primary_photo_url",
    "property_address", "property_type", "saved_at", "source", "sqft", "state", "user_id",
  ],
  agent_client_messages: [
    "agent_kind", "approved_at", "approved_by", "audience", "body", "brokerage_id", "channel",
    "created_at", "entity_id", "entity_type", "id", "managed_agent_session_id", "proposed_at",
    "rationale", "recipient_contact_id", "send_error", "sent_at", "status", "subject",
  ],
  remotion_composition_renders: [
    "agent_user_id", "brokerage_id", "completed_at", "composition_id", "created_at", "entity_id",
    "entity_type", "error_message", "id", "input_props", "is_published", "output_url",
    "public_slug", "published_at", "render_status", "requested_via", "scope_id", "scope_type",
    "thumbnail_url", "used_did_avatar", "used_intro_asset_id", "used_music_asset_id",
    "used_outro_asset_id", "used_voiceover",
  ],
}
