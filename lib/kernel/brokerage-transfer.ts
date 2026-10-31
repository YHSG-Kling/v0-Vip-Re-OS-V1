// lib/kernel/brokerage-transfer.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE EXPLICIT TRANSFER RAIL — INDEPENDENT SUBSCRIBER → BROKERAGE LOCATION
// (wave 141, lane 141A). Owner, 2026-10-14 (verbatim): "Later adoption by the
// ACTUAL brokerage location = a deliberate relationship transfer: identify the
// exact brokerage/location → explicit agent/team permission → verify → migrate
// membership/data through canonical services → preserve history/evidence → stop
// individual billing at the right effective time → Stripe proration → no double
// billing → brokerage owns the seat/platform relationship … Migration:
// idempotent, cannot cross to the wrong brokerage/location, invoices immutable,
// no lost paid period, no fabricated refund, provenance of contacts/
// transactions/websites/campaigns/assets preserved."
//
// SURVIVORS AUDITED AT 01a71c3c2 — none did this, each is REUSED here:
//   · lib/kernel/users.ts assignUserToBrokerage (users + agents + grants move),
//     assignUserRoleAndEntitlements (user_type + the target grant),
//     createOrRepairUserDomainRecords (tier-aware domain rows in the target) —
//     the canonical membership services; this rail never writes users.brokerage_id.
//   · lib/agents/agent-books.ts / agent-deactivation.ts — the AGENT → AGENT
//     book move inside one tenant (contacts, leads, deal roles, tasks, listings,
//     calendar, alerts). Its move SET names the families a book is made of;
//     TRANSFER_DATA_FAMILIES below is that set widened to the owner's list
//     (campaigns, assets, documents) — every entry carries brokerage_id (the
//     proof derives it from scripts/schema-snapshot.ts + live-tables.ts).
//   · lib/kernel/tenant-creation.ts — the resumable step RECORD pattern
//     (status per step, re-run only what did not finish, one ledger row per
//     attempt) is copied, not re-invented.
//   · lib/billing/subscriber-billing-handoff.ts — the ONE billing call; the
//     Stripe side is lane 141H's behind that contract.
//   · brokerages.status 'archived' + archived_at (live, readerful, WRITERLESS
//     until now) — the archive step is their first writer. Archived, never deleted.
//   · lib/kernel/tenant-readiness.ts evaluateTenantReadiness — the verdict on
//     the target after the move.
//
// IDENTITY (lib/kernel/brokerage-identity.ts): every id on a request is CANONICAL —
// the target is the initiator's SESSION tenant, the source is resolved from the
// subject's account email (users.email → users.brokerage_id), the subject must
// be that tenant's owner. A brokerage NAME never selects anything here.
//
// CANNOT CROSS TO ANOTHER TENANT: every data update is pinned
// `.eq("brokerage_id", source)` and sets brokerage_id to the REQUEST ROW's target
// (never a caller value); the request row itself pins brokerage_id = target
// (m765 CHECK); a request can only be consented by its subject, cancelled or
// retried by its target's admins. A same-name third tenant is never read.
//
// EVIDENCE (LAW 5): one agent_action_ledger row per request / consent / cancel /
// migration ATTEMPT (withActionLedger), the request row's jsonb stages (consent,
// verification, migration steps with counts, billing handoff, readiness), and
// kernel events (audit rows with lineage). HUMANS through registered managers
// only (TRANSFER_HUMAN_ROUTES): the Recruiting Manager carries the roster side
// (consent asked / recorded, completion), the Data Steward a verification or
// data-move failure and a not-ready target, the Finance Manager a pending
// billing handoff. No superadmin fallback, no invented manager.
//
// IMMEDIATE (wave 141): consent → verify → migrate → post-condition → event →
// human, in the consent call itself. A stalled migration is resumable
// (runBrokerageTransferMigration again — a tenant-admin retry door); nothing
// waits for a cron. A second run of a completed transfer changes nothing.

import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { TenantReadinessVerdict } from "@/lib/kernel/tenant-creation"
import type { SubscriberBillingHandoffInput, SubscriberBillingHandoffResult } from "@/lib/billing/subscriber-billing-handoff"
import type { UserDomainRole, UserProvisioningParams, ProvisioningResult } from "@/lib/kernel/users"
import type { SeatGateVerdict } from "@/lib/kernel/seat-usage"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { isIndependentSubscriberTier } from "@/lib/kernel/brokerage-identity"

// ── Vocabulary (ONE spelling; m765 CHECKs mirror these) ───────────────────────

export const TRANSFER_STATUSES = ["requested", "consented", "migrating", "completed", "declined", "cancelled", "failed"] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]
export const OPEN_TRANSFER_STATUSES: readonly TransferStatus[] = ["requested", "consented", "migrating"]

/** The seat an adopted owner takes — a producing role, never an admin role by adoption. */
export const TRANSFER_TARGET_ROLES = ["agent", "team_lead"] as const
export type TransferTargetRole = (typeof TRANSFER_TARGET_ROLES)[number]

export const TRANSFER_MIGRATION_STEPS = ["verification", "membership", "data", "billing_handoff", "archive_source", "target_readiness"] as const
export type TransferStep = (typeof TRANSFER_MIGRATION_STEPS)[number]

/** The tenant-stewarded families an independent subscriber's business is made of — each carries
 *  brokerage_id and moves AS A WHOLE (the solo/team tenant's rows are all the adopted agent/team's).
 *  Deliberately NOT here (they stay with the archived tenant, readable by platform staff — history
 *  and evidence are preserved, money never crosses tenants): subscriptions, billing_invoices,
 *  ai_tool_usage, vendor_usage_tracking, agent_action_ledger, lifecycle_events, notifications,
 *  brokerage_settings / policies / entitlements / feature flags / managed_agents, commission_*,
 *  agent_book_transfers, user_invitations, and the BROKERAGE-level rows of brokerage_form_library (wave 144I, m853:
 *  a brokerage packet's licence is the source workspace's and it is shared with every agent of its brokerage — moving
 *  it would hand a licensed form to the whole adopting brokerage; the m853 CHECK pins its path under the source).
 *  A TEAM's packets (brokerage_form_library.team_id) are NOT a family either: they follow their TEAM in the membership
 *  step, the way the team itself does (same team id, same `teams/{teamId}/packets/…` path).
 *  brokerage_required_documents is NOT a family either (owner ruling 21, wave 145 — lane 145H's carry, wired by lane
 *  145Z): a moved team's rules are COPIED as the team's rules in the adopting brokerage by
 *  lib/compliance/team-checklist-carry.ts carryTeamChecklistRules in the membership step; the source rows stay as history. */
export const TRANSFER_DATA_FAMILIES: readonly { table: string; what: string }[] = [
  { table: "contacts", what: "the book — contacts (agents see contacts; §5)" },
  { table: "leads", what: "unconverted leads the tenant owned" },
  { table: "transactions", what: "deals, with their agent role columns intact" },
  { table: "transaction_tasks", what: "deal checklists" },
  { table: "listings", what: "listings" },
  { table: "listing_media", what: "listing photos / media" },
  { table: "offers", what: "offers on those listings / for those buyers" },
  { table: "contract_term_versions", what: "the executed-terms record of those offers (wave 143, m797 — a child of offers / transactions; follows its parent)" },
  { table: "outside_offer_messages", what: "the outside-agent email loop on those offers (wave 143, m798 — a child of offers; follows its parent)" },
  { table: "showings", what: "showings" },
  { table: "tasks", what: "open work" },
  { table: "calendar_events", what: "appointments" },
  { table: "property_alerts", what: "buyer alerts" },
  { table: "activities", what: "activity timeline rows" },
  { table: "contact_notes", what: "notes on contacts" },
  { table: "contact_memory", what: "conversation memory facts per contact" },
  { table: "documents", what: "deal / listing documents" },
  { table: "client_documents", what: "client-visible documents" },
  { table: "marketing_campaigns", what: "campaigns" },
  { table: "campaign_sequences", what: "sequences (the one delivery engine)" },
  { table: "sequence_enrollments", what: "enrollments in those sequences" },
  { table: "marketing_attribution_credits", what: "attribution credits (the ROI ledger's rows)" },
  { table: "email_campaigns", what: "email campaigns" },
  { table: "marketing_assets", what: "the media library (lineage intact)" },
  { table: "ai_video_projects", what: "video projects" },
  { table: "video_assets", what: "rendered videos" },
  { table: "blog_posts", what: "the website's blog" },
  // THE WEBSITE'S LANDING PAGES (wave 143G; owner: "landing pages live inside the tenant website"; wave 141 owner list:
  // "provenance of … websites … preserved"). The page keeps its slug, so every printed QR / sent link / live ad still
  // resolves — but its brokerage_id decides which tenant a visitor's submission is filed under. Left behind, a
  // transferred agent's landing page would keep capturing leads into the ARCHIVED source tenant, where nobody reads
  // them. The two tables that FK to the page (form_id -> lead_capture_forms) move WITH it: a submission left in the
  // source would reference a form that lives in another tenant.
  { table: "lead_capture_forms", what: "the website's landing pages / lead magnets (slug, copy and URL unchanged)" },
  { table: "form_submissions", what: "the capture history of those landing pages (form_id stays in ONE tenant)" },
  { table: "ai_search_landing_citation_observations", what: "AI-search citation history of those landing pages (form_id stays in ONE tenant)" },
  // wave 146 (m883, lane 146F; placed by 146Z): what one of those landing pages PROMISED a submitter and the evidence it was
  // delivered (ruling 10). Every parent it names moves — form_id → lead_capture_forms, submission_id → form_submissions,
  // contact_id → contacts, campaign_id → marketing_campaigns — so it follows the page (the landing-page zero-exception rule).
  { table: "lead_magnet_promises", what: "the promises those landing pages made each submitter, with their delivery evidence (form_id / submission_id stay in ONE tenant)" },
  // WAVE 147 (lane 147Z — lane 147I Outside-lane 5; placed like wave 146's lead_magnet_promises): three tables born in wave 147
  // that FK onto moved families are the tenant's OWN business data and move WITH it (never left behind pointing across tenants):
  //  · lead_magnet_deliverables (m898, contract C11) — the produced asset of one of those landing pages: form_id → lead_capture_forms,
  //    so it follows its page (the landing-page zero-exception rule, scripts/brokerage-identity-guard.ts);
  //  · buyer_criteria_changes (m896, contract C10) — the client's own criteria history (what they said, accepted, rejected):
  //    contact_id → contacts — the book it belongs to moves, so its history does (a proposal left behind would re-offer a
  //    change the buyer already rejected);
  //  · movement_signals (m892, contract C9) — the tenant's evidence about its own contacts / leads (with its outcome history):
  //    contact_id → contacts, lead_id → leads. Tenant-owned like the contacts it describes; its licence / consent provenance
  //    rides each row (and a raw-lead subject keeps its raw_lead_id — raw_scraped_leads is derived_readonly and re-scraped in
  //    the target, never copied).
  // Holding the FK-closure ceiling (scripts/brokerage-identity-guard.ts FROZEN_UNMOVED_FK_CHILDREN, never raised).
  { table: "lead_magnet_deliverables", what: "the produced delivery asset of each of those landing pages (C11; form_id stays in ONE tenant)" },
  { table: "buyer_criteria_changes", what: "each buyer's criteria change history — stated, accepted, rejected (C10; contact_id stays in ONE tenant)" },
  { table: "movement_signals", what: "the C9 movement records on the tenant's own contacts / leads, with their provenance and outcomes (contact_id / lead_id stay in ONE tenant)" },
  // …and the watcher's last-seen digest per watched item (m894) follows the records it points at (last_signal_id →
  // movement_signals): the target's watcher continues from the same baseline (no history re-raised as "new") and the FK
  // stays in ONE tenant. Still doorless by design (service-role only — scripts/production-readiness-guard.ts).
  { table: "movement_source_items", what: "the movement watcher's last-seen digest per watched item (follows movement_signals via last_signal_id)" },
  // A BOOK DISTRIBUTED THROUGH ONE OF THOSE PAGES follows the page (wave 145, lane 145Z — owner ruling 19 + the landing-page
  // zero-exception rule, scripts/brokerage-identity-guard.ts): book_projects.distribution_form_id → lead_capture_forms (m867).
  // The subscriber's OWN book (its manuscript, chapters, publishing state) moves with its workspace; a PLATFORM-owned book has
  // no source brokerage_id and is never selected (correct ownership — ruling 19).
  { table: "book_projects", what: "the workspace's own book projects (a book distributed as a lead magnet keeps its Book entity)" },
  { table: "farm_territories", what: "farm territories served" },
  { table: "relationship_edges", what: "the knowledge graph edges" },
]

// ── FK-CHILD TRANSFER CLASSIFICATION (wave 145, lane 145A — owner ruling 24, 2026-10-27) ─────────────────────────────────
// Owner, verbatim essentials: "do NOT move all 286 … Classify each FK child relationship (ownership follows parent · shared
// relationship remains · historical reference immutable · explicit transfer required · not transferable · derived/read-only) on
// real domain definitions and tenant policy; never transfer another party's contacts, confidential documents, financial records
// or unrelated brokerage property because an agent changes brokerage; code-level checks and tests now, live transfers only on
// explicit authorization."
//
// THE CENSUS (derived, never listed by hand — scripts/transfer-classification-guard.ts): every live FK in the generated FK cache
// (scripts/schema-fk-map.ts) that points INTO a TRANSFER_DATA_FAMILIES table, from a table that is not itself a family. At HEAD
// b364eb4b: 286 child tables carrying brokerage_id (411 FKs) + 20 tables with no tenant column (21 FKs). Every one of the 306
// tables has exactly ONE class below; each of its FKs onto a moved parent resolves to that class. A FK between two FAMILIES
// (59 at HEAD) is "follows_parent" by construction — both ends move in the data step.
//
// WHAT THE RAIL DOES WITH IT (runBrokerageTransferMigration):
//   · verification REFUSES (fail closed) when a moved family, or a child named for moving, is classified anything but
//     follows_parent — so "not_transferable" / "explicit_transfer" can never be moved by this rail, by code or by a proof seam;
//   · the data step moves ONLY the follows_parent children the owner has AUTHORIZED (TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN —
//     EMPTY: ruling 24, "live transfers only on explicit authorization"), each pinned, counted and post-conditioned like a family;
//   · it then COUNTS what stays behind in the explicit_transfer and safety-critical classes and routes it to the Data Steward
//     (TRANSFER_HUMAN_ROUTES.explicit_transfer_pending) with the owner-approval plan
//     (docs/architecture/FK-CHILD-TRANSFER-CLASSIFICATION.md). Nothing in those classes is ever moved here.

export const CHILD_TRANSFER_CLASSES = ["follows_parent", "shared_remains", "historical_immutable", "explicit_transfer", "not_transferable", "derived_readonly"] as const
export type ChildTransferClass = (typeof CHILD_TRANSFER_CLASSES)[number]

/** What each class MEANS (the definitions the classification below is held to). */
export const CHILD_TRANSFER_CLASS_MEANING: Readonly<Record<ChildTransferClass, string>> = Object.freeze({
  follows_parent: "part of the parent's own record (its sub-records, workflow state, the client's stated preferences, the agent's work product on it) — it belongs to whoever owns the parent; moved only once the owner authorizes the table",
  shared_remains: "a relationship with ANOTHER party (a vendor of the source bench, an outside agent, a title company's users, a referral / credit partner, a deal-team member's portal grant) — it stays where it was formed and the target re-establishes its own",
  historical_immutable: "what the SOURCE did — communications sent under its sender identity and consent basis, outreach, deliveries, analytics events, audits and evidence (LAW 5): immutable, kept with the archived source, readable by platform staff",
  explicit_transfer: "another person's rights or the source brokerage's executed contract (consent, privacy requests, the client's own financial data, a listing / buyer-broker agreement, confidential deal documents) — it may move only by an explicit, evidenced, per-transfer human decision; this rail never moves it",
  not_transferable: "money, billing / usage, the supervising broker's compliance file, ad-account property and bearer tokens — never crosses tenants",
  derived_readonly: "computed from the parent (scores, predictions, insights, health, matches, AI drafts / plans, provider enrichment and scrapes, queues) — never moved; recomputed, re-enriched or re-planned in the target from the moved parent",
})

/** THE CLASSIFICATION — one rule per group, each table in exactly one group (the guard proves coverage and uniqueness). */
const CHILD_CLASS_GROUPS: ReadonlyArray<{ cls: ChildTransferClass; rule: string; tables: readonly string[] }> = [
  // ── not transferable ──
  { cls: "not_transferable", rule: "MONEY — commission, payout, earnest-money (trust), books, cost, invoice and referral-fee records stay with the brokerage that booked them; money never crosses tenants (m765; ruling 9: a referral obligation is the executing brokerage's)", tables: [
    "agent_commissions", "commission_adjustments", "commission_calculations", "commission_distributions", "commission_splits", "transaction_commissions",
    "closing_disclosure_agreement", "company_books_obligations", "deposits", "cost_breakdown_tracking", "transaction_cost_breakdown", "net_sheet_reconciliations",
    "referrals", "listing_marketing_packages", "listing_marketing_services", "vendor_invoices",
    // wave 145 (lane 145Z, from lane 145C Outside-lane 9): the partner's EXECUTED referral agreement (m860) is the
    // executing brokerage's ruling-9 obligation and a confidential document — never moved.
    "referral_partners"] },
  { cls: "not_transferable", rule: "BILLING / USAGE — metered usage and vendor spend are the source subscription's invoice lines", tables: ["usage_events", "vendor_usage_tracking"] },
  { cls: "not_transferable", rule: "SUPERVISION — the supervising broker's compliance file for the deal (record retention binds the brokerage that supervised); the target runs its own review", tables: ["compliance_alerts", "compliance_checklists", "compliance_flags", "compliance_tasks"] },
  { cls: "not_transferable", rule: "AD-ACCOUNT PROPERTY — campaigns, creatives and audiences live in the source's connected ad accounts (spend, platform terms); the target rebuilds them in its own", tables: ["ad_campaigns", "ad_creative_variations", "audience_members"] },
  { cls: "not_transferable", rule: "BEARER TOKENS / INVITES — never re-scoped to another tenant; the target re-issues them", tables: ["buyer_intake_tokens", "portal_contact_invites"] },
  // ── explicit transfer required ──
  { cls: "explicit_transfer", rule: "EXECUTED AGREEMENT WITH THE SOURCE BROKERAGE — a listing / buyer-broker agreement is the client's contract with the brokerage, not the agent; it moves only on the client's executed assignment or release. A client-agreement FEE (m859, ruling 5) is a term of that agreement and follows it (lane 145C Outside-lane 9: 'ownership follows the agreement') — so it is never moved apart from it", tables: ["listing_agreements", "buyer_broker_agreements", "client_agreement_fees"] },
  { cls: "explicit_transfer", rule: "CONFIDENTIAL DEAL DOCUMENTS — third-party PII and signatures in the source's deal file; moved only on an explicit, evidenced release (ruling 24)", tables: ["transaction_documents", "generated_documents"] },
  { cls: "explicit_transfer", rule: "CONSENT AND PRIVACY RIGHTS — given to the source sender / controller and never assumed by another; fail-safe while unmoved (the target treats the person as unconsented until consent is re-obtained or a compliance-approved copy lands)", tables: ["contact_consent_events", "newsletter_subscribers", "data_subject_requests"] },
  { cls: "explicit_transfer", rule: "THE CLIENT'S OWN FINANCIAL DATA — credit, income, loan applications; moved only with the client's authorization (contacts see only their own financials — CLAUDE.md §5)", tables: ["buyer_financial_profiles", "credit_accounts", "credit_status", "lender_applications"] },
  // ── shared relationship remains ──
  { cls: "shared_remains", rule: "THE SOURCE'S VENDOR BENCH — the vendor relationship (and its vendors row, which does not move) is the source brokerage's; moving the row would point the target at another tenant's vendor", tables: [
    "contact_vendors", "vendor_assignments", "vendor_bookings", "vendor_contact_assignments", "vendor_jobs", "vendor_reviews", "transaction_vendor_services", "title_orders"] },
  { cls: "shared_remains", rule: "ANOTHER PARTY'S ACCESS OR RELATIONSHIP — outside agents, title-company users, deal-team members with portal grants, credit / referral partners: re-established by the target, never silently re-scoped", tables: [
    "outside_agent_contact_links", "title_company_users", "deal_team_members", "credit_partner_referrals", "referral_sources"] },
  // ── historical reference immutable ──
  { cls: "historical_immutable", rule: "COMMUNICATIONS — sent or received under the source's sender identity, number and consent basis (TCPA / CAN-SPAM evidence)", tables: [
    "communications", "conversation_logs", "conversations", "messages", "email_sends", "email_tracking", "newsletter_sends", "voice_calls", "client_portal_messages",
    "chat_sessions", "embed_sessions", "live_agent_sessions", "smart_landing_sessions", "agent_assistant_sessions", "lead_conversation_history", "transaction_communications"] },
  { cls: "historical_immutable", rule: "OUTREACH AND DELIVERIES — what the source's managers and campaigns sent, gifted or reported", tables: [
    "ai_isa_activities", "ai_isa_calls", "ai_isa_engagement_tracking", "isa_outreach_log", "intelligent_outreach_log", "campaign_bundle_dispatches", "direct_mail_recipients",
    "direct_mail_responses", "mail_response_tracking", "marketing_campaign_touchpoints", "sequence_step_executions", "lifetime_customer_touchpoints", "review_requests",
    "showing_feedback_requests", "open_house_invitations", "open_house_rsvp_tracking", "seller_share_feed", "seller_updates", "seller_weekly_reports",
    "client_friendly_updates", "timeline_transparency", "transparency_updates", "closing_notifications", "thank_you_notes", "client_gifts", "closing_gifts", "notifications"] },
    // lead_magnet_promises (m883) is NOT classified here: it is a moved FAMILY (TRANSFER_DATA_FAMILIES — it follows its landing page).
  { cls: "historical_immutable", rule: "OBSERVED EVENTS AND ANALYTICS — behaviour, views, clicks, scans and signals observed by the source", tables: [
    "blog_post_share_clicks", "blog_post_views", "behavioral_signals", "buyer_behavior_log", "client_portal_activity", "external_behavior", "lead_behavioral_data",
    "lead_external_behavior", "lead_idx_property_interactions", "lead_property_searches", "lead_score_history", "podcast_analytics_events", "portal_access_logs",
    "portal_event_stream", "property_alert_delivery_log", "property_search_log", "property_views", "qr_scan_events", "site_activity", "video_engagement_events",
    "website_visitors", "calculator_history", "google_search_activity", "nextdoor_activity", "listing_page_analytics", "ai_search_citation_observations",
    "intelligence_signals_log", "manager_signals", "open_house_attendees", "open_house_feedback", "social_publish_log", "listing_syndication_tracking"] },
  { cls: "historical_immutable", rule: "AUDIT, EVIDENCE AND PROVENANCE — policy decisions, compliance and fair-housing logs, privacy acceptances, e-sign envelopes, extraction / field audits, dedup / assignment / distribution logs, support tickets", tables: [
    "communication_audit_log", "outbound_message_compliance_log", "transaction_compliance_log", "policy_decisions", "fair_housing_logs", "privacy_acceptances",
    "document_field_audit", "document_extraction_log", "signature_requests", "deconflict_suppression_log", "assignment_log", "lead_deduplication_log", "data_health_logs",
    "automation_errors", "outcome_reconciliations", "platform_lead_distributions", "lead_sla_tracking", "seo_optimization_log", "support_tickets", "business_card_scans"] },
  { cls: "historical_immutable", rule: "JOBS AND RUNS — renders, enhancement jobs, packet jobs and workflow runs the source executed (and paid for)", tables: [
    "workflow_runs", "workflow_webhook_events", "video_render_log", "remotion_composition_renders", "photo_enhancement_jobs", "listing_packet_jobs"] },
  // ── derived / read-only ──
  { cls: "derived_readonly", rule: "COMPUTED FROM THE PARENT — scores, predictions, health, insights, matches, checklists instantiated from policy, AI drafts and plans; recomputed in the target from the moved parent", tables: [
    "ai_autopilot_plans", "ai_comp_scores", "ai_insights", "ai_listing_optimizations", "ai_message_drafts", "buyer_behavior_predictions", "buyer_fatigue_scores",
    "call_analyses", "campaign_roi", "client_detailed_personas", "client_engagement_scores", "closing_checklist_items", "closing_cost_accuracy_observations",
    "comp_risk_flags", "contact_property_insights", "contact_segments", "contract_reviews", "conversation_insights", "conversation_intelligence", "copilot_plans",
    "deal_autopsies", "deal_autopsy_observations", "deal_health_components", "deal_health_factors", "deal_health_scores", "deal_health_snapshots",
    "document_checklist", "document_field_extractions", "fatigue_alerts", "generated_content", "home_value_estimates", "income_gap_recommended_actions",
    "investor_deal_matches", "investor_offmarket_candidates", "lead_engagement_scores", "lead_intelligence", "lead_scores", "lead_value_journey",
    "learning_assignments", "lifetime_customer_npv_scores", "listing_health_interventions", "listing_health_scores", "listing_metrics", "motivated_seller_signals",
    "negotiation_strategies", "neighborhood_reports", "net_sheet_calculations", "offer_comparison", "person_identities", "predictive_lead_scores",
    "predictive_listing_actions", "predictive_listing_scores", "price_predictions", "price_trend_alerts", "proactive_interventions", "property_alert_results",
    "property_intelligence", "property_matches", "scheduled_touchpoints", "showing_analytics", "showing_briefings", "signal_reactivations", "smart_checklists",
    "smart_showing_recommendations", "social_intelligence", "strategy_outcomes", "strategy_recommendations", "transaction_health_factors", "unified_lead_profile",
    "video_performance_tracking", "wealth_advisor_recommendations"] },
  { cls: "derived_readonly", rule: "PROVIDER ENRICHMENT, SCRAPES AND QUEUES — re-enriched under the target's own provider accounts (gap-only, ruling 12) or re-queued; never copied across accounts", tables: [
    "lead_enrichment_queue", "lead_osint_data", "lead_people_data", "lead_property_ownership", "lead_social_intelligence", "batchdata_motivated_sellers_raw",
    "raw_scraped_leads", "social_search_raw_results", "zenrows_property_search_raw", "video_generation_queue", "video_streaming_status"] },
  // NOT NAMED HERE BY DESIGN (wave 145, lane 145Z): the ruling-12 research store (m864) is FIREWALLED — no lib/ or app/ module
  // other than its store may name its table (lane 145F's rule). It declares its own class (derived_readonly, never moved) at
  // lib/enrichment/protected-research-store.ts PROTECTED_RESEARCH_TRANSFER_CLASS; this rail never reads or moves it, and
  // scripts/transfer-classification-guard.ts counts that self-declaration in the census.
  // ── ownership follows parent ──
  { cls: "follows_parent", rule: "THE DEAL FILE — milestones, deadlines, timeline, parties, inspections, repairs, closing prep and the deal's own lender / escrow details", tables: [
    "transaction_milestones", "transaction_deadlines", "transaction_timeline", "transaction_pending_actions", "transaction_closing_prep", "transaction_inspections",
    "transaction_repair_negotiations", "transaction_participants", "transaction_assignments", "transaction_lenders", "transaction_title_escrow",
    "transaction_agent_roles", "trid_timeline", "buyer_move_cases", "document_requests", "document_folders", "workflow_intake_sessions"] },
  { cls: "follows_parent", rule: "THE LISTING FILE — its own price and stage history, inquiries, landing pages, marketing content, presentations, open houses, showings and tours", tables: [
    "listing_price_changes", "pricing_history", "listing_stage_history", "listing_inquiries", "listing_landing_pages", "listing_marketing_content",
    "listing_presentations", "presentation_sections", "listing_promo_videos", "open_house_events", "property_upgrades", "cma_reports", "showing_requests",
    "showing_feedback", "tour_stops", "tours", "appointments", "neighbor_notification_campaigns"] },
  { cls: "follows_parent", rule: "THE CLIENT RECORD — the client's stated preferences, saved homes, journey state, opt-outs, qualification and the agent's notes / reviews / intro videos", tables: [
    "contact_portal_modules", "contact_portal_preferences", "contact_suppression_list", "property_interests", "property_preferences", "property_feedback",
    "saved_properties", "collaborative_searches", "collaborative_search_properties", "offer_intents", "valuation_requests", "journey_states",
    "journey_stage_progress", "journey_task_completions", "ai_isa_qualifications", "ai_assistant_notes", "drip_campaigns", "agent_reviews", "agent_intro_videos"] },
  { cls: "follows_parent", rule: "CAMPAIGN AND CONTENT COMPONENTS — schedules, steps, tasks, triggers, QR codes (printed codes keep resolving), sub-campaigns and the content cut from a moved project", tables: [
    "blog_post_keywords", "campaign_calendar", "campaign_sequence_steps", "marketing_campaign_comments", "marketing_campaign_tasks", "marketing_campaign_triggers",
    "marketing_asset_qr_links", "qr_codes", "direct_mail_campaigns", "newsletter_campaigns", "newsletter_video_renders", "podcast_episodes", "social_posts",
    "video_scripts_library", "video_snippets", "training_videos", "calendar_sync_mappings", "calendar_sync_conflicts"] },
  // book_projects (m867) is NOT classified here: it is a moved FAMILY (TRANSFER_DATA_FAMILIES — it follows its landing page).
]

/** table → its class and the rule that decided it. Built from the groups (a table named twice is caught by the guard). */
export const FK_CHILD_TRANSFER_CLASSIFICATION: Readonly<Record<string, { cls: ChildTransferClass; rule: string }>> = Object.freeze(
  Object.fromEntries(CHILD_CLASS_GROUPS.flatMap((g) => g.tables.map((t) => [t, { cls: g.cls, rule: g.rule }] as const))),
)
/** @proofSeam the guard proves every table is named exactly once (the record above would silently keep the LAST naming). */
export const FK_CHILD_CLASS_NAMINGS: number = CHILD_CLASS_GROUPS.reduce((n, g) => n + g.tables.length, 0)


/**
 * follows_parent children the OWNER has authorized this rail to move live (ruling 24: "live transfers only on explicit
 * authorization"). EMPTY in wave 145 — the owner-approval plan (docs/architecture/FK-CHILD-TRANSFER-CLASSIFICATION.md) names the
 * proposed batches, safety-critical first. Adding a table here IS the authorization; verification refuses any table that is not
 * follows_parent, so this list can never carry money, consent, documents or another party's rows.
 */
export const TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN: readonly string[] = []

/**
 * follows_parent children whose ABSENCE in the target is unsafe, counted and routed to a human on every transfer until the owner
 * authorizes them: an opt-out left in the archived source is invisible to the target (lib/lead-intent/lead-opt-out.ts and
 * lib/direct-mail/address-suppression.ts read contact_suppression_list `.eq("brokerage_id", …)`), so the adopted contact could be
 * messaged again. (A consent left behind is the safe direction — the target sees no consent and sends nothing.)
 */
export const TRANSFER_SAFETY_CRITICAL_CHILDREN: readonly string[] = ["contact_suppression_list"]

// ── RESTRICTIONS ARE COPIED, NEVER MOVED (wave 146, lane 146A — owner, 2026-10-29: "opt-outs and consent restrictions preserved;
// no silent ownership change"; the owner's transfer vocabulary "authorized copies") ──────────────────────────────────────────────
// A safety-critical child whose rows are RESTRICTIONS — an opt-out / do-not-contact entry keyed on the person, their email, their
// phone or their household's mailing address — is COPIED into the adopting brokerage in the data step, row for row, while the
// original stays with the archived source as the evidence of when and how the person asked (TCPA / CAN-SPAM). A copy moves no
// ownership: the source record is untouched, and a restriction can only STOP sending — so the target is never more permissive than
// the source was, which is the whole of the safety argument. It is not the owner's Step-0 authorization to MOVE the table (that
// stays TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN; when it is given, the rows move and no copy is made). Every copy is counted on the
// migration record (closure.restrictions_copied) and named in the Data Steward's closure note — never silent. The re-opt-in door
// (lib/lead-intent/lead-opt-out.ts) finds a copy exactly as it finds a native row, because the copy keeps every column but the id
// and the tenant. Consent itself is NOT copied (contact_consent_events is explicit_transfer): a consent given to the source is never
// assumed by the target, which then treats the person as unconsented — the safe direction.
const TRANSFER_RESTRICTION_COPY_CHILDREN: readonly string[] = ["contact_suppression_list"]
/** Page size of the restriction copy's source read (PostgREST caps an unbounded read at 1000 rows — a silent truncation). */
const RESTRICTION_COPY_PAGE = 500

/** PURE: why the rail must refuse to run — a moved family or a child named for moving that is not follows_parent (module-private:
 *  the guard proves it through the REAL rail, scripts/transfer-classification-guard.ts A3). */
function transferClassificationProblems(families: readonly string[], movingChildren: readonly string[]): string[] {
  const out: string[] = []
  for (const t of families) {
    const own = FK_CHILD_TRANSFER_CLASSIFICATION[t]?.cls
    if (own && own !== "follows_parent") out.push(`family ${t} is classified ${own} — a family must be follows_parent`)
  }
  for (const t of movingChildren) {
    const c = FK_CHILD_TRANSFER_CLASSIFICATION[t]?.cls ?? null
    if (c !== "follows_parent") out.push(`${t} is ${c ?? "UNCLASSIFIED"} — only an owner-authorized follows_parent child may move`)
  }
  return out
}

/** A restriction row's identity for the copy's de-duplication: a household (channel + mailing-address key — the table's live
 *  UNIQUE index per tenant), or a person (channel + contact + email + phone). */
function restrictionKey(r: Record<string, unknown>): string {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v))
  return r.mailing_address_key
    ? `household|${s(r.channel)}|${s(r.mailing_address_key)}`
    : `person|${s(r.channel)}|${s(r.contact_id)}|${s(r.email).toLowerCase()}|${s(r.phone)}`
}

/**
 * COPY a restriction table's source rows into the target (module-private; proven through the REAL rail by
 * scripts/transfer-classification-guard.ts A6). Every column but the id and the tenant is kept — the original reason, source and
 * timestamp are the evidence. Idempotent: a restriction the target already holds (same key) is not inserted again, and a 23505 from
 * the household index reads as "already there". Paged, so a large list is never silently truncated. Any refused read or insert
 * is an ERROR (the data step stalls for a human) — an opt-out that did not reach the target must never read as done.
 */
async function copyRestrictionsToTarget(svc: any, table: string, sourceId: string, targetId: string): Promise<{ ok: true; copied: number; already: number } | { ok: false; error: string }> {
  const readAll = async (brokerageId: string): Promise<{ rows: Array<Record<string, unknown>>; error?: string }> => {
    const out: Array<Record<string, unknown>> = []
    for (let from = 0; ; from += RESTRICTION_COPY_PAGE) {
      const { data, error } = await svc.from(table).select("*").eq("brokerage_id", brokerageId).order("id", { ascending: true }).range(from, from + RESTRICTION_COPY_PAGE - 1)
      if (error) return { rows: out, error: error.message }
      const page = (data ?? []) as Array<Record<string, unknown>>
      out.push(...page)
      if (page.length < RESTRICTION_COPY_PAGE) return { rows: out }
    }
  }
  const src = await readAll(sourceId)
  if (src.error) return { ok: false, error: `the source's ${table} could not be read: ${src.error}` }
  if (src.rows.length === 0) return { ok: true, copied: 0, already: 0 }
  const tgt = await readAll(targetId)
  if (tgt.error) return { ok: false, error: `the target's ${table} could not be read: ${tgt.error}` }
  const held = new Set(tgt.rows.map(restrictionKey))
  let copied = 0, already = 0
  for (const row of src.rows) {
    const key = restrictionKey(row)
    if (held.has(key)) { already += 1; continue }
    const { id: _id, brokerage_id: _b, ...rest } = row
    const { data, error } = await svc.from(table).insert({ ...rest, brokerage_id: targetId }).select("id")
    if (error && String((error as { code?: string }).code ?? "") === "23505") { already += 1; held.add(key); continue }
    if (error) return { ok: false, error: `a ${table} restriction could not be copied to the target: ${error.message}` }
    if (!(data ?? []).length) return { ok: false, error: `a ${table} restriction copy returned no row` }
    copied += 1
    held.add(key)
  }
  return { ok: true, copied, already }
}

/** Rows a closure count stops at (a count, not a census — the human sees "N+" beyond it). */
const CLOSURE_COUNT_CAP = 500

export type TransferHumanTouchpoint = "consent_requested" | "consent_recorded" | "declined" | "verification_failed" | "data_move_failed" | "billing_pending" | "target_not_ready" | "completed" | "explicit_transfer_pending"

/** HUMANS THROUGH REGISTERED MANAGERS ONLY (owner, wave 141). Every value is a MANAGERS key. */
export const TRANSFER_HUMAN_ROUTES: Readonly<Record<TransferHumanTouchpoint, ManagerKey>> = Object.freeze({
  consent_requested: "recruiting_manager",
  consent_recorded: "recruiting_manager",
  declined: "recruiting_manager",
  completed: "recruiting_manager",
  verification_failed: "data_steward",
  data_move_failed: "data_steward",
  target_not_ready: "data_steward",
  billing_pending: "finance_manager",
  // wave 145 (ruling 24): explicit-transfer / safety-critical children left in the archived source need a human decision.
  explicit_transfer_pending: "data_steward",
})

/** users.user_type values that are SEATS of the moving tenant (the operational admin roster spread,
 *  never restated — CLAUDE.md §4 — plus the producing / staff seat types). Contacts, vendors, the ISA
 *  system actor and platform staff never move. */
const MOVING_SEAT_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES, "agent", "tc"])

/** Target tenant states that may adopt. brokerages.status vocabulary: active | archived | cancelled | suspended. */
const ADOPTING_STATUSES: ReadonlySet<string> = new Set(["active"])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Shapes ────────────────────────────────────────────────────────────────────

interface StepState { status: "done" | "failed" | "skipped"; at: string; detail?: string; error?: string }

export interface TransferMigrationRecord {
  version: 1
  attempts: number
  steps: Partial<Record<TransferStep, StepState>>
  /** Rows moved per family / members / teams — exact counts from the updates' returned ids. */
  counts: Record<string, number>
  last_error?: string | null
  /** wave 145 (ruling 24): what the classification kept in the archived source for a human — rows held per explicit_transfer /
   *  safety-critical table (a count stops at CLOSURE_COUNT_CAP), the tables that could not be read (never "0"), and when. */
  closure?: { at: string; explicit_transfer: Record<string, number>; safety_critical: Record<string, number>; unread: string[]; authorized_moved: Record<string, number>
    /** wave 146 (lane 146A): restriction rows COPIED into the target (never moved — the source keeps its evidence); per table, the
     *  rows this run inserted. A table absent here was not copied (authorized to move instead, or the copy is not on). */
    restrictions_copied?: Record<string, number> }
}

export interface TransferConsentEvidence {
  user_id: string
  at: string
  decision: "consent" | "decline"
  statement: string
  channel: string
  request_snapshot: { source_brokerage_id: string; target_brokerage_id: string; target_role: TransferTargetRole; source_name: string | null; target_name: string | null }
}

export interface TransferRequestRow {
  id: string
  brokerage_id: string
  source_brokerage_id: string
  target_brokerage_id: string
  subject_user_id: string
  initiated_by_user_id: string
  target_role: TransferTargetRole
  status: TransferStatus
  reason: string | null
  consent: TransferConsentEvidence | null
  verification: { at: string; ok: boolean; checks: Array<{ key: string; ok: boolean; detail: string }> } | null
  migration: TransferMigrationRecord | null
  billing_handoff: SubscriberBillingHandoffResult | null
  readiness: TenantReadinessVerdict | null
  effective_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

/** @proofSeam — production callers never pass this; scripts/brokerage-identity-guard.ts injects the
 *  env-bound services (the users.ts movers, the seat gate, entitlements, billing, readiness, the event
 *  bus, the notifiers) so the rail is proven in memory with every table write visible. */
export interface BrokerageTransferDeps {
  now?: () => Date
  assignUserToBrokerage?: (p: { userId: string; brokerageId: string; callerUserId: string }) => Promise<{ success: boolean; error?: string }>
  assignRole?: (p: { userId: string; newRole: UserDomainRole; brokerageId: string; teamId?: string | null; callerUserId: string }) => Promise<{ success: boolean; error?: string }>
  domainRecords?: (p: UserProvisioningParams) => Promise<ProvisioningResult>
  seatGate?: (svc: any, brokerageId: string, role: string, opts?: { subjectUserId?: string | null }) => Promise<Pick<SeatGateVerdict, "allowed" | "reason" | "message">>
  tierAllowsRole?: (tier: string | null | undefined, role: UserDomainRole) => boolean
  mayUseAndAfford?: (i: { brokerageId: string; capability: string; client?: any }) => Promise<{ allowed: boolean; reason: string }>
  billingHandoff?: (svc: any, input: SubscriberBillingHandoffInput) => Promise<SubscriberBillingHandoffResult>
  readiness?: (svc: any, brokerageId: string) => Promise<TenantReadinessVerdict>
  /** Wave 141B's immediate-operation reporter (lib/kernel/immediate-operations.ts reportOperationOutcome). */
  reportOutcome?: (svc: any, input: Record<string, unknown>) => Promise<unknown>
  emit?: (input: Record<string, unknown>) => Promise<unknown>
  notifyAdmins?: (svc: any, brokerageId: string, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
  notifyStaff?: (svc: any, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
  /** Proof seam for the owner-authorized follows_parent children (production reads TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN).
   *  Verification still refuses any table here that is not follows_parent — the seam cannot move a protected class. */
  authorizedFollowingChildren?: readonly string[]
  /** Proof seam for the team-checklist carry (production: lib/compliance/team-checklist-carry.ts carryTeamChecklistRules). */
  carryTeamChecklist?: (svc: any, input: { sourceBrokerageId: string; targetBrokerageId: string; teamIds: string[]; includeWorkspaceRules: boolean; actorUserId: string; reason: string }) => Promise<{ ok: true; carried: number; held: unknown[] } | { ok: false; error: string }>
}

export interface TransferActor {
  userId: string
  /** The actor's SESSION tenant (never a request body) — checked against the request's side. */
  brokerageId: string
  kind: "target_admin" | "subject" | "system"
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** @proofSeam scripts/brokerage-identity-guard.ts asserts the step algebra directly. */
export function transferMigrationComplete(record: Pick<TransferMigrationRecord, "steps"> | null | undefined): boolean {
  if (!record) return false
  return TRANSFER_MIGRATION_STEPS.every((s) => { const st = record.steps[s]?.status; return st === "done" || st === "skipped" })
}

/** @proofSeam scripts/brokerage-identity-guard.ts asserts the pending set after a stalled step. */
export function transferStepsPending(record: Pick<TransferMigrationRecord, "steps"> | null | undefined): TransferStep[] {
  if (!record) return [...TRANSFER_MIGRATION_STEPS]
  return TRANSFER_MIGRATION_STEPS.filter((s) => { const st = record.steps[s]?.status; return st !== "done" && st !== "skipped" })
}

/** PURE: the seat a moving member takes in the target. The subject takes the requested role; an
 *  admin-class member of a team tenant becomes a producing agent (adoption never grants admin);
 *  producing / staff types keep their own. */
export function memberTargetRole(userType: string | null, isSubject: boolean, requested: TransferTargetRole): UserDomainRole {
  if (isSubject) return requested
  if (TENANT_ADMIN_USER_TYPES.has(String(userType ?? ""))) return "agent"
  return (userType === "tc" ? "tc" : "agent") as UserDomainRole
}

function nowIso(deps: BrokerageTransferDeps): string { return (deps.now ?? (() => new Date()))().toISOString() }

function managerLabel(key: ManagerKey): string {
  return key.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

// ── Row access (every write counted; CLAUDE.md §3) ─────────────────────────────

async function readRequest(svc: any, requestId: string): Promise<{ row: TransferRequestRow | null; error: string | null }> {
  const { data, error } = await svc.from("brokerage_transfer_requests").select("*").eq("id", requestId).maybeSingle()
  if (error) return { row: null, error: error.message }
  return { row: (data ?? null) as TransferRequestRow | null, error: null }
}

async function patchRequest(svc: any, requestId: string, patch: Record<string, unknown>, deps: BrokerageTransferDeps): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await svc.from("brokerage_transfer_requests").update({ ...patch, updated_at: nowIso(deps) }).eq("id", requestId).select("id")
  if (error) return { ok: false, error: error.message }
  if ((data ?? []).length !== 1) return { ok: false, error: "transfer request row not matched" }
  return { ok: true }
}

async function readBrokerage(svc: any, id: string) {
  const { data, error } = await svc.from("brokerages").select("id, name, plan_tier, status, deleted_at, archived_at, ai_isa_system_user_id").eq("id", id).maybeSingle()
  if (error) return { row: null, error: error.message as string }
  return { row: (data ?? null) as { id: string; name: string | null; plan_tier: string | null; status: string | null; deleted_at: string | null; archived_at: string | null; ai_isa_system_user_id: string | null } | null, error: null }
}

async function emitTransferEvent(svc: any, deps: BrokerageTransferDeps, event: string, brokerageId: string, requestId: string, actorUserId: string | null, metadata: Record<string, unknown>) {
  try {
    const emit = deps.emit ?? (await import("@/lib/kernel/emit")).emitKernelEvent
    await emit({ event, brokerageId, entityType: "brokerage_transfer_request", entityId: requestId, actorUserId, auditOnly: true, metadata, client: svc })
  } catch (e) {
    console.warn(`[brokerage-transfer] event ${event} not recorded:`, (e as Error)?.message)
  }
}

/** A human, through the registered manager that owns the touchpoint — never a superadmin fallback. */
async function notifyHumans(svc: any, deps: BrokerageTransferDeps, touch: TransferHumanTouchpoint, req: Pick<TransferRequestRow, "id" | "brokerage_id" | "source_brokerage_id" | "subject_user_id">, body: string, opts: { targetAdmins?: boolean; staff?: boolean; subject?: boolean } = {}): Promise<{ admins: number; staff: number; subject: boolean }> {
  const manager = TRANSFER_HUMAN_ROUTES[touch]
  const title = `${managerLabel(manager)}: brokerage adoption — ${touch.replace(/_/g, " ")}`
  const out = { admins: 0, staff: 0, subject: false }
  if (opts.targetAdmins) {
    try {
      const notify = deps.notifyAdmins ?? (await import("@/lib/notifications/brokerage-admins")).notifyBrokerageAdmins
      out.admins = await notify(svc, req.brokerage_id, { type: `brokerage_transfer_${touch}`, title, body, entityType: "brokerage_transfer_request", entityId: req.id, priority: "high" })
    } catch (e) { console.warn("[brokerage-transfer] target admins not notified:", (e as Error)?.message) }
  }
  if (opts.staff) {
    try {
      const notify = deps.notifyStaff ?? (async (client: any, n: any) => (await import("@/lib/notifications/platform-staff")).notifyPlatformStaff(client as never, n))
      out.staff = await notify(svc, { type: `brokerage_transfer_${touch}`, title, body, entityType: "brokerage_transfer_request", entityId: req.id, priority: "high" })
    } catch (e) { console.warn("[brokerage-transfer] platform staff not notified:", (e as Error)?.message) }
  }
  if (opts.subject) {
    const { error } = await svc.from("notifications").insert({
      user_id: req.subject_user_id, brokerage_id: req.source_brokerage_id, type: `brokerage_transfer_${touch}`,
      title: title.slice(0, 200), body: body.slice(0, 480), entity_type: "brokerage_transfer_request", entity_id: req.id,
      priority: "high", channel: "in_app", is_read: false,
    })
    if (error) console.warn("[brokerage-transfer] subject bell refused:", error.message)
    out.subject = !error
  }
  return out
}

async function ledgered<T extends { ok: boolean; error?: string }>(svc: any, ctx: { brokerageId: string; action: string; actorUserId: string | null; subjectId: string; key: string; riskClass: "LOW_RISK_WRITE" | "FINANCIAL"; detail: Record<string, unknown> }, run: () => Promise<T>, onRefused: (why: string) => T): Promise<T> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<T>({
    brokerageId: ctx.brokerageId, action: ctx.action,
    actor: ctx.actorUserId ? { type: "user", userId: ctx.actorUserId } : { type: "system" },
    subject: { type: "brokerage_transfer_request", id: ctx.subjectId, ref: ctx.key },
    reasonCode: "SUBSCRIPTION_LIFECYCLE", idempotencyKey: ctx.key, riskClass: ctx.riskClass, systemSource: "brokerage_transfer", detail: ctx.detail,
  }, run, {
    settle: (r) => r.ok ? { status: "executed", outcome: ctx.action.split(".").pop() ?? "done", providerRef: ctx.subjectId, error: null } : { status: "failed", outcome: "refused", error: r.error ?? null },
    replay: (claim) => onRefused(claim.kind === "refused" ? claim.error : claim.kind),
  }, { client: svc })
}

// ── 1. REQUEST (the target brokerage admin, from their session tenant) ────────

export interface RequestBrokerageTransferInput {
  /** The initiator's SESSION tenant — the adopting brokerage / location / team. */
  targetBrokerageId: string
  initiatedByUserId: string
  /** The adopted owner's ACCOUNT email — the identity key; never a brokerage name. */
  subjectEmail: string
  targetRole: TransferTargetRole
  reason?: string | null
}

export type RequestBrokerageTransferResult =
  | { ok: true; request: TransferRequestRow; notified: { subject: boolean } }
  | { ok: false; error: string }

export async function requestBrokerageTransfer(svc: any, input: RequestBrokerageTransferInput, deps: BrokerageTransferDeps = {}): Promise<RequestBrokerageTransferResult> {
  const targetId = String(input.targetBrokerageId ?? "")
  if (!UUID_RE.test(targetId)) return { ok: false, error: "No adopting tenant — refused." }
  if (!(TRANSFER_TARGET_ROLES as readonly string[]).includes(input.targetRole)) return { ok: false, error: `The adopted owner's seat must be one of: ${TRANSFER_TARGET_ROLES.join(", ")}.` }
  const email = String(input.subjectEmail ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "The agent's account email is required — it is how the independent workspace is identified (never by brokerage name)." }

  const target = await readBrokerage(svc, targetId)
  if (target.error) return { ok: false, error: `Could not read your brokerage: ${target.error}` }
  if (!target.row || target.row.deleted_at) return { ok: false, error: "Your brokerage record could not be found." }
  if (!ADOPTING_STATUSES.has(String(target.row.status ?? ""))) return { ok: false, error: `Your brokerage is '${target.row.status}' — only an active brokerage can adopt a workspace.` }
  if (target.row.plan_tier === "solo_agent") return { ok: false, error: "A solo workspace cannot adopt another workspace — the adopting side must be a team, brokerage or multi-location tenant." }

  const { data: subjectRow, error: subjectErr } = await svc.from("users").select("id, email, brokerage_id, user_type, platform_role, first_name, last_name").eq("email", email).maybeSingle()
  if (subjectErr) return { ok: false, error: `Could not look the account up: ${subjectErr.message}` }
  const subject = subjectRow as { id: string; brokerage_id: string | null; user_type: string | null; platform_role: string | null; first_name: string | null; last_name: string | null } | null
  if (!subject) return { ok: false, error: "No account with that email — the agent must be an independent subscriber on the platform to be adopted." }
  if (subject.platform_role) return { ok: false, error: "That account is platform staff, not a subscriber." }
  const sourceId = subject.brokerage_id
  if (!sourceId) return { ok: false, error: "That account holds no workspace — invite them as a user instead (Settings → Users)." }
  if (sourceId === targetId) return { ok: false, error: "That account is already a member of your brokerage." }

  const source = await readBrokerage(svc, sourceId)
  if (source.error) return { ok: false, error: `Could not read the independent workspace: ${source.error}` }
  if (!source.row || source.row.deleted_at) return { ok: false, error: "The independent workspace could not be found." }
  if (source.row.archived_at || source.row.status === "archived") return { ok: false, error: "That workspace is already archived." }
  if (!isIndependentSubscriberTier(source.row.plan_tier)) return { ok: false, error: `That account belongs to a ${String(source.row.plan_tier ?? "").replace(/_/g, " ")} tenant, not an independent solo/team subscription — a brokerage's member cannot be adopted away; they must leave it first.` }
  if (!TENANT_ADMIN_USER_TYPES.has(String(subject.user_type ?? ""))) return { ok: false, error: "That account is not the owner of its workspace — only the independent workspace's owner can consent to a transfer." }

  // One open request per source tenant (the m765 partial unique index says the same).
  const { data: open, error: openErr } = await svc.from("brokerage_transfer_requests").select("id, brokerage_id, status").eq("source_brokerage_id", sourceId).in("status", [...OPEN_TRANSFER_STATUSES]).limit(1)
  if (openErr) return { ok: false, error: `Could not check for an open request: ${openErr.message}` }
  if ((open ?? []).length) {
    const o = (open as Array<{ brokerage_id: string; status: string }>)[0]
    return { ok: false, error: o.brokerage_id === targetId ? `A request for this workspace is already ${o.status}.` : "That workspace already has an open adoption request with another brokerage." }
  }

  const tierAllows = deps.tierAllowsRole ?? (await import("@/lib/kernel/tier-role-matrix")).tierAllowsRole
  if (!tierAllows(target.row.plan_tier, input.targetRole)) return { ok: false, error: `Your ${String(target.row.plan_tier ?? "").replace(/_/g, " ")} plan does not seat a ${input.targetRole.replace(/_/g, " ")}.` }
  const gate = deps.seatGate ?? (await import("@/lib/kernel/seat-usage")).seatGate
  const seat = await gate(svc, targetId, input.targetRole, { subjectUserId: subject.id })
  if (!seat.allowed) return { ok: false, error: seat.message ?? `Seat check refused (${seat.reason}).` }
  const afford = deps.mayUseAndAfford ?? (await import("@/lib/billing/billing-access")).mayUseAndAfford
  const access = await afford({ brokerageId: targetId, capability: "app.access", client: svc })
  if (!access.allowed) return { ok: false, error: `Your subscription cannot take on a workspace right now (${access.reason}).` }

  const at = nowIso(deps)
  const key = `transfer:request:${sourceId}:${targetId}:${at}`
  return ledgered<RequestBrokerageTransferResult>(svc, {
    brokerageId: targetId, action: "tenant.transfer.request", actorUserId: input.initiatedByUserId, subjectId: sourceId, key, riskClass: "LOW_RISK_WRITE",
    detail: { source_brokerage_id: sourceId, target_role: input.targetRole, subject_user_id: subject.id },
  }, async () => {
    const { data: inserted, error: insErr } = await svc.from("brokerage_transfer_requests").insert({
      brokerage_id: targetId, source_brokerage_id: sourceId, target_brokerage_id: targetId,
      subject_user_id: subject.id, initiated_by_user_id: input.initiatedByUserId, target_role: input.targetRole,
      status: "requested", reason: (input.reason ?? "").trim().slice(0, 500) || null,
      consent: null, verification: null, migration: null, billing_handoff: null, readiness: null,
      effective_at: null, completed_at: null, created_at: at, updated_at: at,
    }).select("*").single()
    if (insErr || !inserted) return { ok: false as const, error: `Transfer request not recorded: ${insErr?.message ?? "no row"}` }
    const request = inserted as TransferRequestRow
    await emitTransferEvent(svc, deps, "brokerage_transfer_requested", targetId, request.id, input.initiatedByUserId, { source_brokerage_id: sourceId, target_role: input.targetRole, subject_user_id: subject.id })
    const notified = await notifyHumans(svc, deps, "consent_requested", request,
      `${target.row!.name ?? "A brokerage"} has asked to adopt your workspace "${source.row!.name ?? ""}" as its ${input.targetRole.replace(/_/g, " ")}. Nothing moves until you consent in Settings → General → Brokerage affiliation.`,
      { subject: true })
    return { ok: true as const, request, notified: { subject: notified.subject } }
  }, (why) => ({ ok: false, error: `Transfer request evidence could not be recorded (${why}) — nothing was requested.` }))
}

// ── 2. CONSENT / DECLINE (the subject, from their own session) ───────────────

export interface TransferConsentInput {
  requestId: string
  actor: TransferActor
  decision: "consent" | "decline"
  /** The subject's own words — recorded verbatim as evidence (required for consent). */
  statement: string
  channel: string
}

export type TransferConsentResult =
  | { ok: true; request: TransferRequestRow; migration: RunTransferMigrationResult | null }
  | { ok: false; error: string }

export async function recordBrokerageTransferConsent(svc: any, input: TransferConsentInput, deps: BrokerageTransferDeps = {}): Promise<TransferConsentResult> {
  const read = await readRequest(svc, input.requestId)
  if (read.error) return { ok: false, error: `Could not read the request: ${read.error}` }
  const req = read.row
  if (!req) return { ok: false, error: "Transfer request not found." }
  if (req.subject_user_id !== input.actor.userId || req.source_brokerage_id !== input.actor.brokerageId) return { ok: false, error: "Only the owner of the workspace being adopted can answer this request." }
  if (req.status !== "requested") return { ok: false, error: `This request is ${req.status} — it cannot be answered again.` }
  const statement = String(input.statement ?? "").trim()
  if (input.decision === "consent" && statement.length < 8) return { ok: false, error: "Consent needs your own statement (a sentence in your words) — it is recorded as evidence." }

  const [source, target] = await Promise.all([readBrokerage(svc, req.source_brokerage_id), readBrokerage(svc, req.target_brokerage_id)])
  const at = nowIso(deps)
  const consent: TransferConsentEvidence = {
    user_id: input.actor.userId, at, decision: input.decision, statement: statement.slice(0, 1000), channel: String(input.channel ?? "settings_ui").slice(0, 60),
    request_snapshot: { source_brokerage_id: req.source_brokerage_id, target_brokerage_id: req.target_brokerage_id, target_role: req.target_role, source_name: source.row?.name ?? null, target_name: target.row?.name ?? null },
  }
  const nextStatus: TransferStatus = input.decision === "consent" ? "consented" : "declined"
  const key = `transfer:consent:${req.id}`
  const recorded = await ledgered<{ ok: boolean; error?: string }>(svc, {
    brokerageId: req.brokerage_id, action: "tenant.transfer.consent", actorUserId: input.actor.userId, subjectId: req.id, key, riskClass: "LOW_RISK_WRITE",
    detail: { decision: input.decision, source_brokerage_id: req.source_brokerage_id, channel: consent.channel },
  }, async () => {
    const { data, error } = await svc.from("brokerage_transfer_requests").update({ status: nextStatus, consent, updated_at: at }).eq("id", req.id).eq("status", "requested").select("id")
    if (error) return { ok: false, error: `Consent not recorded: ${error.message}` }
    if ((data ?? []).length !== 1) return { ok: false, error: "Consent not recorded: the request changed underneath you." }
    return { ok: true }
  }, (why) => ({ ok: false, error: `Consent evidence could not be recorded (${why}) — nothing changed.` }))
  if (!recorded.ok) return { ok: false, error: recorded.error ?? "consent refused" }

  await emitTransferEvent(svc, deps, input.decision === "consent" ? "brokerage_transfer_consented" : "brokerage_transfer_declined", req.brokerage_id, req.id, input.actor.userId, { source_brokerage_id: req.source_brokerage_id, channel: consent.channel })
  await notifyHumans(svc, deps, input.decision === "consent" ? "consent_recorded" : "declined", req,
    input.decision === "consent"
      ? `${source.row?.name ?? "The workspace"} consented to the adoption; the migration is running now.`
      : `${source.row?.name ?? "The workspace"} declined the adoption request${statement ? `: "${statement.slice(0, 200)}"` : "."}`,
    { targetAdmins: true })

  const after = await readRequest(svc, req.id)
  if (input.decision === "decline" || !after.row) return { ok: true, request: after.row ?? { ...req, status: nextStatus, consent }, migration: null }
  // IMMEDIATE: consent → verify → migrate, in this same call. A stall is recorded and resumable.
  const migration = await runBrokerageTransferMigration(svc, { requestId: req.id, actor: { ...input.actor, kind: "subject" } }, deps)
  const final = await readRequest(svc, req.id)
  return { ok: true, request: final.row ?? after.row, migration }
}

// ── 3. CANCEL (the target brokerage admin, before migration starts) ──────────

export async function cancelBrokerageTransferRequest(svc: any, input: { requestId: string; actor: TransferActor; reason?: string | null }, deps: BrokerageTransferDeps = {}): Promise<{ ok: boolean; error?: string }> {
  const read = await readRequest(svc, input.requestId)
  if (read.error) return { ok: false, error: `Could not read the request: ${read.error}` }
  const req = read.row
  if (!req) return { ok: false, error: "Transfer request not found." }
  if (req.brokerage_id !== input.actor.brokerageId) return { ok: false, error: "That request belongs to another brokerage." }
  if (req.status !== "requested" && req.status !== "consented") return { ok: false, error: `A ${req.status} request cannot be cancelled${req.status === "migrating" ? " — the migration is in progress; retry it to finish" : ""}.` }
  const at = nowIso(deps)
  const r = await ledgered<{ ok: boolean; error?: string }>(svc, {
    brokerageId: req.brokerage_id, action: "tenant.transfer.cancel", actorUserId: input.actor.userId, subjectId: req.id, key: `transfer:cancel:${req.id}`, riskClass: "LOW_RISK_WRITE",
    detail: { reason: input.reason ?? null, was: req.status },
  }, async () => {
    const { data, error } = await svc.from("brokerage_transfer_requests").update({ status: "cancelled", reason: (input.reason ?? req.reason ?? "").toString().slice(0, 500) || null, updated_at: at }).eq("id", req.id).in("status", ["requested", "consented"]).select("id")
    if (error) return { ok: false, error: error.message }
    if ((data ?? []).length !== 1) return { ok: false, error: "The request changed underneath you — nothing cancelled." }
    return { ok: true }
  }, (why) => ({ ok: false, error: `Cancellation evidence could not be recorded (${why}) — nothing changed.` }))
  if (r.ok) await emitTransferEvent(svc, deps, "brokerage_transfer_cancelled", req.brokerage_id, req.id, input.actor.userId, { reason: input.reason ?? null })
  return r
}

// ── 4. MIGRATE (verify → membership → data → billing → archive → readiness) ──

export interface RunTransferMigrationInput { requestId: string; actor: TransferActor }

export type RunTransferMigrationResult =
  | { ok: true; completed: true; alreadyCompleted: boolean; record: TransferMigrationRecord; readiness: TenantReadinessVerdict | null }
  | { ok: false; completed: false; stalledAt: TransferStep | null; error: string; record: TransferMigrationRecord | null }

export async function runBrokerageTransferMigration(svc: any, input: RunTransferMigrationInput, deps: BrokerageTransferDeps = {}): Promise<RunTransferMigrationResult> {
  const read = await readRequest(svc, input.requestId)
  if (read.error) return { ok: false, completed: false, stalledAt: null, error: `Could not read the request: ${read.error}`, record: null }
  const req = read.row
  if (!req) return { ok: false, completed: false, stalledAt: null, error: "Transfer request not found.", record: null }
  // WHO MAY RUN IT: the target's admins (their session tenant is the request's), the subject right
  // after consenting (their session tenant is the source), or the system (a continuation).
  if (input.actor.kind === "target_admin" && req.brokerage_id !== input.actor.brokerageId) return { ok: false, completed: false, stalledAt: null, error: "That request belongs to another brokerage.", record: req.migration }
  if (input.actor.kind === "subject" && (req.subject_user_id !== input.actor.userId || req.source_brokerage_id !== input.actor.brokerageId)) return { ok: false, completed: false, stalledAt: null, error: "Only the consenting owner or the adopting brokerage can run this transfer.", record: req.migration }
  if (req.status === "completed") return { ok: true, completed: true, alreadyCompleted: true, record: req.migration as TransferMigrationRecord, readiness: req.readiness }
  if (req.status !== "consented" && req.status !== "migrating") return { ok: false, completed: false, stalledAt: null, error: `A ${req.status} request cannot be migrated${req.status === "requested" ? " — the workspace owner has not consented" : ""}.`, record: req.migration }
  if (!req.consent || req.consent.decision !== "consent" || req.consent.user_id !== req.subject_user_id) return { ok: false, completed: false, stalledAt: null, error: "No consent evidence from the workspace owner — refused.", record: req.migration }

  const record: TransferMigrationRecord = req.migration && req.migration.version === 1
    ? { ...req.migration, steps: { ...req.migration.steps }, counts: { ...req.migration.counts }, attempts: (req.migration.attempts ?? 0) + 1 }
    : { version: 1, attempts: 1, steps: {}, counts: {} }
  const effectiveAt = req.effective_at ?? nowIso(deps)
  const sourceId = req.source_brokerage_id
  const targetId = req.target_brokerage_id // THE ROW's target — never the caller's
  const actorUserId = input.actor.userId

  const persist = async (extra: Record<string, unknown> = {}) => {
    const r = await patchRequest(svc, req.id, { migration: record, effective_at: effectiveAt, ...extra }, deps)
    if (!r.ok) console.error("[brokerage-transfer] migration record write refused:", r.error, { requestId: req.id })
  }
  const step = async (key: TransferStep, run: () => Promise<{ error?: string | null; skipped?: string | null; detail?: string | null } | void>): Promise<boolean> => {
    const prior = record.steps[key]?.status
    if (prior === "done" || prior === "skipped") return true
    try {
      const r = (await run()) ?? {}
      if (r.skipped) record.steps[key] = { status: "skipped", at: nowIso(deps), detail: r.skipped }
      else if (r.error) { record.steps[key] = { status: "failed", at: nowIso(deps), error: r.error.slice(0, 700) }; record.last_error = r.error.slice(0, 700) }
      else record.steps[key] = { status: "done", at: nowIso(deps), ...(r.detail ? { detail: r.detail } : {}) }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      record.steps[key] = { status: "failed", at: nowIso(deps), error: msg.slice(0, 700) }
      record.last_error = msg.slice(0, 700)
    }
    await persist()
    return record.steps[key]?.status !== "failed"
  }
  const stall = async (at: TransferStep, touch: TransferHumanTouchpoint, body: string, staff: boolean): Promise<RunTransferMigrationResult> => {
    await emitTransferEvent(svc, deps, "brokerage_transfer_stalled", targetId, req.id, actorUserId, { step: at, error: record.last_error ?? null, attempt: record.attempts })
    await notifyHumans(svc, deps, touch, req, body, { targetAdmins: true, staff })
    return { ok: false, completed: false, stalledAt: at, error: record.last_error ?? `stalled at ${at}`, record }
  }
  // THE BILLING ACTOR IS THE APPROVING BROKERAGE ADMIN, NEVER THE SUBJECT (owner, wave 142: "fix the
  // Stripe handoff to use the APPROVING BROKERAGE ADMIN (not the subject user)"). The consent call runs
  // this migration AS THE SUBJECT (kind "subject"), and the Stripe side (lib/billing/subscriber-handoff.ts)
  // admits only an admin OF THE TARGET or platform staff — so every Stripe-linked adoption handed the
  // subject's id over, was refused actor_not_authorized, and stalled at stripe_handoff_pending on consent.
  // The approval IS the request: initiated_by_user_id is the target admin who filed it
  // (app/actions/brokerage-transfer.ts requireAdoptingAdmin). A target admin retrying a stalled run is
  // that admin re-approving it, so their own id is passed; the subject and a system continuation carry
  // the original approver. The ledger keeps the RUNNING actor (who pressed the button) and records the
  // approver beside it.
  const approvingAdminUserId = input.actor.kind === "target_admin" ? input.actor.userId : req.initiated_by_user_id
  // The follows_parent children the owner authorized (ruling 24) — empty in production until the owner adds one.
  const authorizedChildren: readonly string[] = deps.authorizedFollowingChildren ?? TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN

  return ledgered<RunTransferMigrationResult>(svc, {
    brokerageId: targetId, action: "tenant.transfer.migrate", actorUserId, subjectId: req.id, key: `transfer:migrate:${req.id}:attempt:${record.attempts}`, riskClass: "FINANCIAL",
    detail: { source_brokerage_id: sourceId, attempt: record.attempts, pending: transferStepsPending(record), effective_at: effectiveAt, approving_admin_user_id: approvingAdminUserId },
  }, async () => {
    await persist()

    // ── verification: deterministic checks, each recorded; any failure stops before a row moves ──
    // Held in a ref object: these are assigned inside the step closures, and TS narrows a reassigned
    // `let … = null` read after the closure to `never`.
    const ref: { source: Awaited<ReturnType<typeof readBrokerage>>["row"]; target: Awaited<ReturnType<typeof readBrokerage>>["row"]; verdict: TenantReadinessVerdict | null; closureFresh: boolean } = { source: null, target: null, verdict: null, closureFresh: false }
    const okV = await step("verification", async () => {
      const checks: Array<{ key: string; ok: boolean; detail: string }> = []
      const source = await readBrokerage(svc, sourceId)
      const target = await readBrokerage(svc, targetId)
      ref.source = source.row; ref.target = target.row
      checks.push({ key: "source_tenant", ok: !!source.row && !source.row.deleted_at && isIndependentSubscriberTier(source.row.plan_tier), detail: source.error ?? (source.row ? `${source.row.plan_tier} / ${source.row.status}` : "not found") })
      checks.push({ key: "target_tenant", ok: !!target.row && !target.row.deleted_at && ADOPTING_STATUSES.has(String(target.row.status ?? "")) && target.row.plan_tier !== "solo_agent" && target.row.id === req.brokerage_id, detail: target.error ?? (target.row ? `${target.row.plan_tier} / ${target.row.status}` : "not found") })
      checks.push({ key: "source_ne_target", ok: sourceId !== targetId, detail: sourceId === targetId ? "same tenant" : "distinct canonical ids" })
      const { data: subj, error: subjErr } = await svc.from("users").select("id, brokerage_id, user_type").eq("id", req.subject_user_id).maybeSingle()
      const subject = subj as { brokerage_id: string | null; user_type: string | null } | null
      const membershipDone = record.steps.membership?.status === "done"
      checks.push({ key: "subject_in_source", ok: !subjErr && !!subject && (subject.brokerage_id === sourceId || (membershipDone && subject.brokerage_id === targetId)), detail: subjErr?.message ?? (subject ? `users.brokerage_id=${subject.brokerage_id}` : "subject not found") })
      checks.push({ key: "consent", ok: req.consent?.decision === "consent" && req.consent.request_snapshot?.target_brokerage_id === targetId && req.consent.request_snapshot?.source_brokerage_id === sourceId, detail: req.consent ? `recorded ${req.consent.at} via ${req.consent.channel}` : "missing" })
      const tierAllows = deps.tierAllowsRole ?? (await import("@/lib/kernel/tier-role-matrix")).tierAllowsRole
      checks.push({ key: "target_role_on_tier", ok: tierAllows(target.row?.plan_tier, req.target_role), detail: `${req.target_role} on ${target.row?.plan_tier}` })
      if (!membershipDone) {
        const gate = deps.seatGate ?? (await import("@/lib/kernel/seat-usage")).seatGate
        const seat = await gate(svc, targetId, req.target_role, { subjectUserId: req.subject_user_id })
        checks.push({ key: "target_seat", ok: seat.allowed, detail: seat.message ?? seat.reason })
      }
      const afford = deps.mayUseAndAfford ?? (await import("@/lib/billing/billing-access")).mayUseAndAfford
      const access = await afford({ brokerageId: targetId, capability: "app.access", client: svc })
      checks.push({ key: "target_entitled", ok: access.allowed, detail: access.reason })
      // RULING 24 (wave 145): nothing this run would move may be a protected class — fail closed on a misclassified family or an
      // authorized child that is not follows_parent (money, consent, documents and another party's rows never move here).
      const classProblems = transferClassificationProblems(TRANSFER_DATA_FAMILIES.map((f) => f.table), authorizedChildren)
      checks.push({ key: "child_classification", ok: classProblems.length === 0, detail: classProblems.length ? classProblems.join("; ") : `${TRANSFER_DATA_FAMILIES.length} families + ${authorizedChildren.length} authorized child table(s), all follows_parent` })
      const failed = checks.filter((c) => !c.ok)
      const verification = { at: nowIso(deps), ok: failed.length === 0, checks }
      const r = await patchRequest(svc, req.id, { verification, ...(failed.length === 0 ? { status: "migrating" } : {}) }, deps)
      if (!r.ok) return { error: `verification could not be recorded: ${r.error}` }
      if (failed.length) return { error: `verification failed: ${failed.map((c) => `${c.key} (${c.detail})`).join("; ")}` }
      return { detail: `${checks.length} checks passed` }
    })
    if (!okV) return stall("verification", "verification_failed", `The adoption of ${ref.source?.name ?? sourceId} could not be verified: ${record.last_error}. Nothing moved.`, false)
    req.status = "migrating"

    // ── membership: the canonical users.ts movers, owner first; source grants retired first ──
    const okM = await step("membership", async () => {
      const isaId = ref.source?.ai_isa_system_user_id ?? null
      const { data: memberRows, error: memErr } = await svc.from("users").select("id, email, first_name, last_name, user_type, team_id, platform_role").eq("brokerage_id", sourceId).is("platform_role", null)
      if (memErr) return { error: `members read refused: ${memErr.message}` }
      const members = ((memberRows ?? []) as Array<{ id: string; email: string | null; first_name: string | null; last_name: string | null; user_type: string | null; team_id: string | null }>)
        .filter((u) => u.id !== isaId && MOVING_SEAT_TYPES.has(String(u.user_type ?? "")))
        .sort((a, b) => (a.id === req.subject_user_id ? -1 : b.id === req.subject_user_id ? 1 : 0))
      const moveUser = deps.assignUserToBrokerage ?? (await import("@/lib/kernel/users")).assignUserToBrokerage
      const setRole = deps.assignRole ?? (await import("@/lib/kernel/users")).assignUserRoleAndEntitlements
      const domain = deps.domainRecords ?? (await import("@/lib/kernel/users")).createOrRepairUserDomainRecords
      let moved = 0
      for (const u of members) {
        const role = memberTargetRole(u.user_type, u.id === req.subject_user_id, req.target_role)
        // Retire the SOURCE tenant's grants first — assignUserToBrokerage re-pins every grant the user
        // holds, and an 'admin' grant re-pinned to the target would make the adopted agent its admin.
        const { data: retired, error: retireErr } = await svc.from("user_role_assignments").delete().eq("user_id", u.id).eq("brokerage_id", sourceId).select("id")
        if (retireErr) return { error: `grants of ${u.email ?? u.id} could not be retired: ${retireErr.message}` }
        record.counts[`grants_retired`] = (record.counts.grants_retired ?? 0) + (retired ?? []).length
        const mv = await moveUser({ userId: u.id, brokerageId: targetId, callerUserId: actorUserId })
        if (!mv.success) return { error: `${u.email ?? u.id} could not be moved: ${mv.error ?? "refused"}` }
        const rl = await setRole({ userId: u.id, newRole: role, brokerageId: targetId, teamId: u.team_id ?? null, callerUserId: actorUserId })
        if (!rl.success) return { error: `${u.email ?? u.id} moved, but their ${role} seat was refused: ${rl.error ?? "refused"}` }
        const dr = await domain({ userId: u.id, email: u.email ?? "", firstName: u.first_name ?? "", lastName: u.last_name ?? "", userType: role, brokerageId: targetId, teamId: u.team_id ?? null, tier: ref.target?.plan_tier ?? null, callerUserId: actorUserId })
        if (!dr.success) return { error: `${u.email ?? u.id} seated, but their domain records were refused: ${dr.error ?? "refused"}` }
        moved += 1
      }
      record.counts.members = (record.counts.members ?? 0) + moved
      // The team (a mini brokerage) moves as a unit — same id, so every team_id stays coherent.
      const { data: teams, error: teamErr } = await svc.from("teams").update({ brokerage_id: targetId }).eq("brokerage_id", sourceId).select("id")
      if (teamErr) return { error: `teams could not be moved: ${teamErr.message}` }
      record.counts.teams = (record.counts.teams ?? 0) + (teams ?? []).length
      // A TEAM'S FORM PACKETS FOLLOW THE TEAM (wave 144, lane 144I — m853 / lane 144C Outside-lane 3; owner ruling 3:
      // "the brokerage or team uploads approved form packets into THEIR OWN tenant/team bucket"). A team packet
      // (brokerage_form_library.team_id) lives at `teams/{teamId}/packets/…` and the team moves with the SAME id, so the
      // m853 path-under-owner CHECK still holds and the m853 trigger (the team must belong to the row's brokerage) is
      // satisfied because the team moved first. Left behind, the team's own packets would sit in the archived tenant,
      // where its members' RLS (brokerage_id = current_user_brokerage_id()) can no longer reach them.
      // A BROKERAGE-level packet STAYS with the archived source (declared beside TRANSFER_DATA_FAMILIES): its licence is
      // the source workspace's, it is shared with EVERY agent of its brokerage (moving it would hand a licensed form to
      // the whole adopting brokerage — the leakage ruling 3 forbids), and the CHECK pins its path under the source.
      // Pre-m853 (no team_id column — 42703 / PGRST204) no team packet can exist: nothing to move, said in the detail.
      const movedTeamIds = ((teams ?? []) as Array<{ id: string }>).map((t) => t.id)
      let teamPacketNote = ""
      if (movedTeamIds.length) {
        const { data: pk, error: pkErr } = await svc.from("brokerage_form_library").update({ brokerage_id: targetId }).eq("brokerage_id", sourceId).in("team_id", movedTeamIds).select("id")
        const missingCol = !!pkErr && (String((pkErr as { code?: string }).code ?? "") === "42703" || String((pkErr as { code?: string }).code ?? "") === "PGRST204")
        if (pkErr && !missingCol) return { error: `the moved team(s)' form packets could not follow them: ${pkErr.message}` }
        if (missingCol) teamPacketNote = ", team form packets: none possible (m853 not applied)"
        else {
          record.counts.team_form_packets = (record.counts.team_form_packets ?? 0) + (pk ?? []).length
          const { data: pkLeft, error: pkLeftErr } = await svc.from("brokerage_form_library").select("id").eq("brokerage_id", sourceId).in("team_id", movedTeamIds).limit(1)
          if (pkLeftErr) return { error: `team form packet post-condition read refused: ${pkLeftErr.message}` }
          if ((pkLeft ?? []).length) return { error: "post-condition failed: a moved team's form packet is still in the source tenant" }
          teamPacketNote = `, ${(pk ?? []).length} team form packet(s)`
        }
      }
      // A TEAM'S REQUIRED-DOCUMENT CHECKLIST FOLLOWS THE TEAM (owner ruling 21, wave 145 — lane 145H's carry; lane 145H
      // Outside-lane 1, wired by lane 145Z). NON-BLOCKING by design: the source rules stay as history either way, and a
      // carry that cannot run is repaired from Settings → Required documents (the settings door carries on request) —
      // so the detail SAYS it, and the adoption is never stalled over a checklist copy.
      let teamChecklistNote = ""
      if (movedTeamIds.length) {
        try {
          const carry = deps.carryTeamChecklist ?? (await import("@/lib/compliance/team-checklist-carry")).carryTeamChecklistRules
          const c = await carry(svc, {
            sourceBrokerageId: sourceId, targetBrokerageId: targetId, teamIds: movedTeamIds,
            includeWorkspaceRules: req.target_role === "team_lead", actorUserId: actorUserId ?? req.initiated_by_user_id, reason: `adoption ${req.id}`,
          })
          if (c.ok) {
            record.counts.team_checklist_rules = (record.counts.team_checklist_rules ?? 0) + c.carried
            teamChecklistNote = `, ${c.carried} team checklist rule(s)${c.held.length ? `, ${c.held.length} held for a person` : ""}`
          } else teamChecklistNote = `, team checklist not carried (${c.error}) — carry it from Settings → Required documents`
        } catch (err) {
          teamChecklistNote = `, team checklist not carried (${(err as Error)?.message ?? err}) — carry it from Settings → Required documents`
        }
      }
      // IMMEDIATE POST-CONDITION: no seat is left behind, and the subject sits in the target.
      const { data: left, error: leftErr } = await svc.from("users").select("id, user_type").eq("brokerage_id", sourceId).is("platform_role", null)
      if (leftErr) return { error: `post-condition read refused: ${leftErr.message}` }
      const stragglers = ((left ?? []) as Array<{ id: string; user_type: string | null }>).filter((u) => u.id !== isaId && MOVING_SEAT_TYPES.has(String(u.user_type ?? "")))
      if (stragglers.length) return { error: `post-condition failed: ${stragglers.length} seat(s) still in the source tenant` }
      const { data: subjNow } = await svc.from("users").select("brokerage_id").eq("id", req.subject_user_id).maybeSingle()
      if ((subjNow as { brokerage_id?: string } | null)?.brokerage_id !== targetId) return { error: "post-condition failed: the adopted owner is not in the target tenant" }
      return { detail: `${moved} member(s), ${(teams ?? []).length} team(s)${teamPacketNote}${teamChecklistNote}` }
    })
    if (!okM) return stall("membership", "data_move_failed", `Membership migration stalled: ${record.last_error}. Retry from Settings → Users once the cause is fixed.`, true)

    // ── data: every family, pinned to the source, re-homed to the ROW's target; post-condition per family ──
    const okD = await step("data", async () => {
      const errors: string[] = []
      for (const fam of TRANSFER_DATA_FAMILIES) {
        const { data: moved, error } = await svc.from(fam.table).update({ brokerage_id: targetId }).eq("brokerage_id", sourceId).select("id")
        if (error) { errors.push(`${fam.table}: ${error.message}`); continue }
        record.counts[fam.table] = (record.counts[fam.table] ?? 0) + (moved ?? []).length
        const { data: left, error: leftErr } = await svc.from(fam.table).select("id").eq("brokerage_id", sourceId).limit(1)
        if (leftErr) errors.push(`${fam.table} post-condition read: ${leftErr.message}`)
        else if ((left ?? []).length) errors.push(`${fam.table}: rows remain in the source after the move`)
      }
      // RULING 24: the owner-AUTHORIZED follows_parent children move exactly like a family (pinned, counted, post-conditioned).
      // Verification already refused anything here that is not follows_parent; re-checked so the move can never run unguarded.
      const authorized_moved: Record<string, number> = {}
      if (transferClassificationProblems([], authorizedChildren).length) errors.push("an authorized child is not follows_parent — nothing moved for it")
      else for (const table of authorizedChildren) {
        const { data: moved, error } = await svc.from(table).update({ brokerage_id: targetId }).eq("brokerage_id", sourceId).select("id")
        if (error) { errors.push(`${table}: ${error.message}`); continue }
        authorized_moved[table] = (moved ?? []).length
        record.counts[table] = (record.counts[table] ?? 0) + (moved ?? []).length
        const { data: left, error: leftErr } = await svc.from(table).select("id").eq("brokerage_id", sourceId).limit(1)
        if (leftErr) errors.push(`${table} post-condition read: ${leftErr.message}`)
        else if ((left ?? []).length) errors.push(`${table}: rows remain in the source after the move`)
      }
      // RESTRICTIONS ARE COPIED, NEVER MOVED (wave 146, lane 146A): every safety-critical restriction table the owner has NOT
      // authorized to move is copied into the target so the adopted people's opt-outs hold there; the originals stay as evidence.
      // A refused copy STALLS the step (an opt-out that did not arrive must never read as done); a retry copies only what is missing.
      const restrictions_copied: Record<string, number> = {}
      for (const table of TRANSFER_RESTRICTION_COPY_CHILDREN) {
        if (authorizedChildren.includes(table) || FK_CHILD_TRANSFER_CLASSIFICATION[table]?.cls !== "follows_parent" || !TRANSFER_SAFETY_CRITICAL_CHILDREN.includes(table)) continue
        const copy = await copyRestrictionsToTarget(svc, table, sourceId, targetId)
        if (!copy.ok) { errors.push(copy.error); continue }
        restrictions_copied[table] = copy.copied
        record.counts[`${table}_copied`] = (record.counts[`${table}_copied`] ?? 0) + copy.copied
      }
      if (errors.length) return { error: `data families refused: ${errors.join("; ")}` }
      // THE CLOSURE REPORT — what the classification KEEPS in the source that a human must decide: every explicit_transfer table and
      // every safety-critical child not authorized. Read only, never moved. A refused read is listed as unread, never as 0.
      const closure: NonNullable<TransferMigrationRecord["closure"]> = { at: nowIso(deps), explicit_transfer: {}, safety_critical: {}, unread: [], authorized_moved, restrictions_copied }
      const held = async (table: string): Promise<number | null> => {
        const { data, error } = await svc.from(table).select("id").eq("brokerage_id", sourceId).limit(CLOSURE_COUNT_CAP)
        return error ? null : (data ?? []).length
      }
      for (const [table, c] of Object.entries(FK_CHILD_TRANSFER_CLASSIFICATION)) {
        if (c.cls !== "explicit_transfer") continue
        const n = await held(table)
        if (n === null) closure.unread.push(table)
        else if (n > 0) closure.explicit_transfer[table] = n
      }
      for (const table of TRANSFER_SAFETY_CRITICAL_CHILDREN.filter((t) => !authorizedChildren.includes(t))) {
        const n = await held(table)
        if (n === null) closure.unread.push(table)
        else if (n > 0) closure.safety_critical[table] = n
      }
      record.closure = closure
      ref.closureFresh = true
      return { detail: TRANSFER_DATA_FAMILIES.map((f) => `${f.table}=${record.counts[f.table] ?? 0}`).concat(Object.entries(authorized_moved).map(([t, n]) => `${t}=${n}`)).join(",") }
    })
    if (!okD) return stall("data", "data_move_failed", `Data migration stalled: ${record.last_error}. Membership already moved; retry from Settings → Users once the cause is fixed.`, true)
    // A human decides what the classification kept behind (never moved here). Routed once — a retry finds the data step done.
    const closure = record.closure
    const pending = closure ? [
      ...Object.entries(closure.safety_critical).map(([t, n]) => {
        const count = n >= CLOSURE_COUNT_CAP ? `${CLOSURE_COUNT_CAP}+` : String(n)
        const copied = closure.restrictions_copied?.[t]
        return copied === undefined
          ? `${t}: ${count} row(s) — SAFETY: the target cannot see these opt-outs`
          : `${t}: ${count} row(s) — SAFETY, HANDLED BY COPY: the originals stay with the archived workspace as evidence and each restriction was COPIED into the adopting brokerage (${copied} inserted by this run; the rest it already held), so these opt-outs hold there; moving the originals still needs the owner's authorization`
      }),
      ...Object.entries(closure.explicit_transfer).map(([t, n]) => `${t}: ${n >= CLOSURE_COUNT_CAP ? `${CLOSURE_COUNT_CAP}+` : n} row(s)`),
      ...closure.unread.map((t) => `${t}: could not be read`),
    ] : []
    if (closure && pending.length && ref.closureFresh) {
      await notifyHumans(svc, deps, "explicit_transfer_pending", req,
        `These records stayed with the archived workspace and need an explicit, evidenced decision before anything moves (docs/architecture/FK-CHILD-TRANSFER-CLASSIFICATION.md — owner-approval plan): ${pending.join("; ")}.`,
        { targetAdmins: true, staff: true })
    }

    // ── billing handoff: the ONE billing call; not ok = nothing changed, archive waits ──
    const okB = await step("billing_handoff", async () => {
      const handoff = deps.billingHandoff ?? (await import("@/lib/billing/subscriber-billing-handoff")).handoffSubscriberBillingToBrokerage
      const r = await handoff(svc, { sourceBrokerageId: sourceId, targetBrokerageId: targetId, effectiveAt, transferRequestId: req.id, actorUserId: approvingAdminUserId })
      const p = await patchRequest(svc, req.id, { billing_handoff: r }, deps)
      if (!p.ok) return { error: `billing handoff evidence not recorded: ${p.error}` }
      if (!r.ok) return { error: `billing handoff pending (${r.code}): ${r.error}` }
      return { detail: `${r.mode} effective ${r.effectiveAt}` }
    })
    if (!okB) return stall("billing_handoff", "billing_pending", `The adopted workspace's individual billing has not been handed off yet: ${record.last_error}. The workspace stays open (not archived) until the Finance Manager completes it; retry afterwards.`, true)

    // ── archive the source: status + archived_at (first writer of a live, readerful column) — never deleted ──
    const okA = await step("archive_source", async () => {
      const at = nowIso(deps)
      const { data, error } = await svc.from("brokerages").update({ status: "archived", archived_at: at, updated_at: at }).eq("id", sourceId).neq("status", "archived").select("id")
      if (error) return { error: `archive refused: ${error.message}` }
      if ((data ?? []).length !== 1) {
        const now = await readBrokerage(svc, sourceId)
        if (now.row?.status === "archived") return { detail: "already archived" }
        return { error: "archive matched no row" }
      }
      await emitTransferEvent(svc, deps, "brokerage_archived", sourceId, req.id, actorUserId, { adopted_by_brokerage_id: targetId, archived_at: at })
      return { detail: `archived ${at}` }
    })
    if (!okA) return stall("archive_source", "data_move_failed", `The adopted workspace could not be archived: ${record.last_error}.`, true)

    // ── the target's readiness verdict (evaluate; repairs are the self-healing engine's) ──
    await step("target_readiness", async () => {
      const evaluate = deps.readiness ?? (async (c: any, id: string) => { const r = await (await import("@/lib/kernel/tenant-readiness")).evaluateTenantReadiness(c, id); return { ready: r.ready, blockers: r.blockers, checkedAt: r.checkedAt } })
      try { ref.verdict = await evaluate(svc, targetId) } catch (e) { ref.verdict = { ready: false, blockers: [`readiness evaluation threw: ${(e as Error).message}`], checkedAt: nowIso(deps) } }
      const p = await patchRequest(svc, req.id, { readiness: ref.verdict }, deps)
      if (!p.ok) return { error: `readiness verdict not recorded: ${p.error}` }
      return { detail: ref.verdict.ready ? "READY" : `NOT READY: ${ref.verdict.blockers.join("; ")}` }
    })

    // IMMEDIATE OPERATION (wave 141B, integrated): the transfer's post-condition verdict is evidenced and, when
    // the brokerage is not READY, routed to its owning manager in-request — never a day/week later.
    try {
      const report = deps.reportOutcome ?? (async (c: any, i: Record<string, unknown>) => (await import("@/lib/kernel/immediate-operations")).reportOperationOutcome(c, i as never))
      await report(svc, { operation: "brokerage_transfer", brokerageId: targetId, ok: !!ref.verdict?.ready, subjectType: "brokerage_transfer_request", subjectId: req.id, actorUserId, evidence: { source_brokerage_id: sourceId, counts: record.counts, effective_at: effectiveAt, readiness: ref.verdict }, error: ref.verdict?.ready ? null : (ref.verdict?.blockers.join("; ") ?? "readiness unknown"), tenantFacing: ref.verdict?.ready ? null : "The adoption completed; the brokerage still has setup to finish before it is fully ready." })
    } catch (e) { record.last_error = `operation report failed: ${(e as Error).message}` }

    const completedAt = nowIso(deps)
    await persist({ status: "completed", completed_at: completedAt })
    await emitTransferEvent(svc, deps, "brokerage_transfer_completed", targetId, req.id, actorUserId, { source_brokerage_id: sourceId, counts: record.counts, effective_at: effectiveAt, ready: ref.verdict?.ready ?? null })
    await notifyHumans(svc, deps, "completed", req, `${ref.source?.name ?? "The workspace"} is now part of ${ref.target?.name ?? "your brokerage"}: ${record.counts.members ?? 0} member(s), ${Object.entries(record.counts).filter(([k]) => !["members", "teams", "grants_retired"].includes(k)).reduce((n, [, v]) => n + v, 0)} record(s) moved; individual billing stopped effective ${effectiveAt}.`, { targetAdmins: true, subject: true })
    if (ref.verdict && !ref.verdict.ready) {
      await notifyHumans(svc, deps, "target_not_ready", req, `The adoption completed but the brokerage is not READY: ${ref.verdict.blockers.join("; ")}.`, { targetAdmins: true })
    }
    return { ok: true, completed: true, alreadyCompleted: false, record, readiness: ref.verdict }
  }, (why) => ({ ok: false, completed: false, stalledAt: null, error: `Transfer evidence could not be recorded (${why}) — nothing moved.`, record }))
}

// ── 5. LIST (for the two settings cards) ──────────────────────────────────────

export async function listBrokerageTransferRequests(svc: any, input: { brokerageId: string; side: "target" | "source"; limit?: number }): Promise<{ ok: boolean; error?: string; requests: TransferRequestRow[] }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  if (input.side === "target") {
    const { data, error } = await svc.from("brokerage_transfer_requests").select("*").eq("brokerage_id", input.brokerageId).order("created_at", { ascending: false }).limit(limit)
    if (error) return { ok: false, error: error.message, requests: [] }
    return { ok: true, requests: (data ?? []) as TransferRequestRow[] }
  }
  const { data, error } = await svc.from("brokerage_transfer_requests").select("*").eq("source_brokerage_id", input.brokerageId).order("created_at", { ascending: false }).limit(limit)
  if (error) return { ok: false, error: error.message, requests: [] }
  return { ok: true, requests: (data ?? []) as TransferRequestRow[] }
}
