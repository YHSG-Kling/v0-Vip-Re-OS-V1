/**
 * lib/kernel/manager-registry.ts
 *
 * THE canonical map of "which Claude manager owns this activity". The One Command
 * Center aggregates every governed action across many surfaces; this registry makes
 * the multi-manager model explicit and accountable — EVERY activity on the egress is
 * owned by a named manager, with ZERO orphans. Adding a new Command Center queue
 * without assigning it here fails the manager-ownership regression test.
 *
 * Pure module (no imports, no server-only) so both the kernel loader (server) and the
 * Command Center UI (client) share ONE source of truth for manager identity + labels —
 * no drift between a server map and a hand-kept client KIND_LABEL.
 *
 * All 11 managers mirror managed_agents.agent_kind (lib/agents/spawn-helper.ts AgentKind):
 * the 7 core managers + Ads Manager (m193) + AI ISA (m197, lead qualification/nurture) +
 * Recruiting Manager (m215, agent recruiting / talent pipeline — brokerage growth) +
 * Data Steward (m203, data integrity / identity / field stewardship across the lead spine).
 *
 * ── PRESERVED MANAGER BOUNDARIES (the product's governance contract) ──────────
 * Sides of the business map to managers precisely — no blurring:
 *   · AI ISA            — leads (unconsented, ISA + brokerage owned) and ISA
 *                         engagement ACTIVITIES: every outreach/call/message the
 *                         ISA logs while qualifying, until handoff converts the
 *                         lead to a contact.
 *   · Listing Concierge — the SELLER side: listings and in-house SHOWINGS of our
 *                         listings (external buyer agents coming through our door,
 *                         ShowingTime sync, access codes, seller feedback loops).
 *   · Shopping Agent    — the BUYER side: TOURS (taking our buyer out, routes,
 *                         stops) and OFFERS the buyer writes, plus preferences,
 *                         matches and saved properties.
 *   · Deal Coordinator  — post-acceptance: transactions, transaction tasks and
 *                         the deal calendar through closing.
 *   · Sphere Manager    — LIFETIME relationships: closed & past clients, repeat
 *                         and referral cultivation after the deal is done.
 * No additional manager is needed for these splits — each boundary lands cleanly
 * on an existing manager's charter; introducing one would dilute accountability.
 */

export type ManagerKey =
  | "deal_coordinator"
  | "shopping_agent"
  | "listing_concierge"
  | "sphere_of_influence"
  | "campaign_orchestrator"
  | "marketing_agent"
  | "asset_manager"
  | "ads_manager"
  | "ai_isa"
  | "data_steward"
  | "recruiting_manager"

export interface ManagerInfo {
  key:    ManagerKey
  label:  string
  /** One-line domain the manager is accountable for (UI tooltip / grouping). */
  domain: string
}

export const MANAGERS: Record<ManagerKey, ManagerInfo> = {
  deal_coordinator:      { key: "deal_coordinator",      label: "Deal Coordinator",      domain: "Transactions & closings" },
  shopping_agent:        { key: "shopping_agent",        label: "Shopping Agent",        domain: "Buyer journey" },
  listing_concierge:     { key: "listing_concierge",     label: "Listing Concierge",     domain: "Sellers & listings" },
  sphere_of_influence:   { key: "sphere_of_influence",   label: "Sphere Manager",        domain: "Lifetime closed & past clients — repeat & referral" },
  campaign_orchestrator: { key: "campaign_orchestrator", label: "Campaign Orchestrator", domain: "Multi-touch campaigns & content" },
  marketing_agent:       { key: "marketing_agent",       label: "Marketing Manager",     domain: "Brand & promotion" },
  asset_manager:         { key: "asset_manager",         label: "Asset Manager",         domain: "Media & brand library" },
  ads_manager:           { key: "ads_manager",           label: "Ads Manager",           domain: "Paid advertising" },
  ai_isa:                { key: "ai_isa",                label: "AI ISA",                domain: "Lead qualification, nurture & re-engagement" },
  data_steward:          { key: "data_steward",          label: "Data Steward",          domain: "Data integrity, identity & field stewardship" },
  recruiting_manager:    { key: "recruiting_manager",    label: "Recruiting Manager",    domain: "Agent recruiting & talent pipeline (brokerage growth)" },
}

/**
 * Every Command Center queue → its owning manager. `client_message` is resolved
 * per-row from the message's agent_kind (any of the deal-critical managers can
 * propose a client message), so it is intentionally absent here and handled by
 * resolveActionManager.
 */
export const QUEUE_MANAGER: Record<string, ManagerKey> = {
  // Agent-action queues
  marketing:              "marketing_agent",
  asset:                  "asset_manager",
  ads:                    "ads_manager",
  // Content-approval queues
  social:                 "marketing_agent",
  newsletter:             "campaign_orchestrator",
  direct_mail:            "marketing_agent",
  ad_creative:            "ads_manager",
  predictive_listing:     "sphere_of_influence",
  transaction_task:       "deal_coordinator",
  transaction_smart_task: "deal_coordinator",
  agent_followup:         "sphere_of_influence",
  blog:                   "campaign_orchestrator",
  podcast:                "campaign_orchestrator",
}

/**
 * MAINTENANCE / BURN-DOMAIN OWNERSHIP — every audit/cleanup workstream on the egress
 * is owned by a named Claude manager, so as code is cleaned and fixed there is always
 * a manager accountable for keeping that domain on the ONE egress. The ownership
 * simulator asserts every domain maps to a real manager (zero orphan burn types),
 * and each domain lists its runnable proof so the owner is tied to a regression,
 * not just a label.
 */
export const MAINTENANCE_DOMAINS: Record<string, { manager: ManagerKey; proof: string; what: string }> = {
  // ── Data Steward — data integrity across the raw → leads → contacts spine ──
  schema_drift_guard:         { manager: "data_steward", proof: "test:schema-drift",       what: "No code references a column the live table lacks; baseline burn-down ratchet" },
  lossless_promotion:         { manager: "data_steward", proof: "test:data-steward",       what: "raw → leads → contacts moves identity/address/enrichment without loss" },
  import_field_mapping:       { manager: "data_steward", proof: "test:data-steward",       what: "CSV/CRM imports: known fields map, unmapped columns preserved in notes" },
  import_value_normalization: { manager: "data_steward", proof: "test:data-steward",       what: "Imported values reconciled to canonical vocabulary (synonyms + gated AI match)" },
  dedup_merge:                { manager: "data_steward", proof: "test:data-steward",       what: "Dedup merges fill empties and preserve conflicts in notes — never drop" },
  enrichment_conservation:    { manager: "data_steward", proof: "test:data-steward",       what: "PeopleData enrichment lands in first-class columns AND jsonb" },
  consent_suppression:        { manager: "data_steward", proof: "test:lead-pipeline",      what: "TCPA consent/opt-out provenance carries faithfully — no fabricated consent" },
  manager_boundaries:         { manager: "data_steward", proof: "test:manager-ownership",  what: "Buyer/seller/lead/lifetime boundaries preserved: tours+offers=buyer (Shopping), in-house showings=listing side, ISA activities=AI ISA, sphere=lifetime past clients" },
  // ── AI ISA — the qualify → assign → convert chain ──
  qualification_chain:        { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Conversation scoring persists; readiness gates handoff" },
  assignment_routing:         { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Tier-aware routing (solo/team/brokerage/multi-location); preview = engine" },
  lead_conversion:            { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Qualification converts to a lossless contact via the canonical converter" },
  credit_pipeline:            { manager: "ai_isa",       proof: "test:schema-drift",       what: "Credit-readiness nurture (kanban mirrors on contacts; credit_accounts canonical)" },
  briefing_isa_overnight:     { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Overnight handoffs/escalations lead the agent + team-lead morning briefs" },
  voice_isa:                  { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Voice calls feed the SAME rolling qualification + canonical handoff chain as email" },
  // ── Surface sections owned by their domain managers ──
  briefing_deal_risk:         { manager: "deal_coordinator",  proof: "test:manager-ownership", what: "Deals-at-risk briefing sections" },
  briefing_listing_risk:      { manager: "listing_concierge", proof: "test:manager-ownership", what: "Listings-at-risk briefing sections" },
  client_message_gate:        { manager: "campaign_orchestrator", proof: "test:client-extract", what: "Every client-facing AI output proposes → human approves → sends" },
  manager_daily_standup:      { manager: "campaign_orchestrator", proof: "test:manager-ownership", what: "Broker's daily per-manager accountability report (manager-standup.ts); every line manager-attributed" },
  manager_weekly_pnl:         { manager: "campaign_orchestrator", proof: "test:command-center", what: "Broker's weekly per-manager production scorecard (manager-weekly-pnl.ts); WoW outcomes incl. GCI" },
  brokerage_owner_report:     { manager: "campaign_orchestrator", proof: "test:brokerage-pnl", what: "Owner's Report — YTD GCI + company dollar, production by agent, recruiting ROI, referral value (brokerage-pnl.ts)" },
  governed_deliverables_rail: { manager: "campaign_orchestrator", proof: "test:deliverables", what: "Unified rail — every loop's gate proposals rolled up (count, human-approved, by manager + loop); the proof-of-system view" },
  seller_update_video:        { manager: "listing_concierge", proof: "test:seller-update-video", what: "Weekly seller-update D-ID avatar video proposed into the client-message gate (no HeyGen)" },
  strategy_learning_loop:     { manager: "shopping_agent",    proof: "test:strategy-learning",  what: "Offer/counter outcomes close the loop back to the recommendation that produced them (strategy_outcomes)" },
  strategy_learning_insights: { manager: "shopping_agent",    proof: "test:strategy-insights",  what: "Accumulated outcomes → market intelligence (win rate, deviation, by strategy type) fed back into the next recommendation" },
  referral_closing_loop:      { manager: "sphere_of_influence", proof: "test:referral-closer", what: "Deal close → matching referral closed, partner lifetime value credited, partner thank-you proposed into the gate" },
  recruiting_outreach_loop:   { manager: "recruiting_manager", proof: "test:recruit-outreach", what: "Recruit stage advance / stale recruit → next recruiting outreach proposed into the gate (talent pipeline kept warm)" },
  vendor_marketplace_loop:    { manager: "deal_coordinator", proof: "test:vendor-loop", what: "Vendor booked → client intro proposed (Deal Coordinator); service completed → client review request proposed (Sphere) — both gated" },
  education_delivery_loop:    { manager: "shopping_agent", proof: "test:education-delivery", what: "Client at a lifecycle stage → side-appropriate concierge proposes the best-matched lesson into the gate + records the assignment" },
}

/**
 * GUARDED-TABLE OWNERSHIP — every table under the schema-drift guard has an owning
 * manager, so every remaining baseline entry (and any future drift) lands on a named
 * manager's burn-down list. The ownership simulator derives the table list from the
 * live snapshot: adding a guarded table without an owner FAILS the regression.
 */
export const TABLE_MANAGER: Record<string, ManagerKey> = {
  contacts:                     "data_steward",
  leads:                        "ai_isa",
  raw_scraped_leads:            "data_steward",
  property_preferences:         "shopping_agent",
  listings:                     "listing_concierge",
  property_matches:             "shopping_agent",
  saved_properties:             "shopping_agent",
  agent_client_messages:        "campaign_orchestrator",
  remotion_composition_renders: "asset_manager",
  notifications:                "campaign_orchestrator",
  assignment_log:               "ai_isa",
  ai_daily_briefings:           "ai_isa",
  transactions:                 "deal_coordinator",
  // Buyer side: the buyer WRITES offers (pre-acceptance) and goes on tours.
  offers:                       "shopping_agent",
  tours:                        "shopping_agent",
  tour_stops:                   "shopping_agent",
  // Seller side: in-house showings OF our listings (external buyer agents,
  // ShowingTime sync, access codes) belong to the listing's manager.
  showings:                     "listing_concierge",
  tasks:                        "deal_coordinator",
  // The activity ledger is dominated by ISA engagement records (outreach, calls,
  // messages while qualifying) — the AI ISA is accountable for it.
  activities:                   "ai_isa",
  calendar_events:              "deal_coordinator",
}

/** Resolve the manager accountable for a maintenance/burn domain (never undefined). */
export function resolveMaintenanceManager(domain: string): ManagerInfo {
  const entry = MAINTENANCE_DOMAINS[domain]
  return entry ? MANAGERS[entry.manager] : FALLBACK_MANAGER
}

/** Resolve the manager accountable for a guarded table's data integrity (never undefined). */
export function resolveTableManager(table: string): ManagerInfo {
  const key = TABLE_MANAGER[table]
  return key ? MANAGERS[key] : FALLBACK_MANAGER
}

/** Fallback owner for any activity not yet mapped — surfaced so nothing is ever truly orphaned. */
export const FALLBACK_MANAGER: ManagerInfo = {
  key: "marketing_agent", label: "Operations", domain: "Unassigned — needs an owner",
}

/**
 * Resolve the owning manager for a Command Center action. For `client_message` the
 * owner is the proposing manager (its agent_kind); for every other queue it's the
 * static QUEUE_MANAGER owner. Never returns undefined (zero-orphan guarantee).
 */
export function resolveActionManager(queue: string, agentKind?: string | null): ManagerInfo {
  if (queue === "client_message") {
    if (agentKind && agentKind in MANAGERS) return MANAGERS[agentKind as ManagerKey]
    return FALLBACK_MANAGER
  }
  const key = QUEUE_MANAGER[queue]
  return key ? MANAGERS[key] : FALLBACK_MANAGER
}
