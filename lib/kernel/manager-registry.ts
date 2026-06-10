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
 * All 10 managers mirror managed_agents.agent_kind (lib/agents/spawn-helper.ts AgentKind):
 * the 7 core managers + Ads Manager (m193) + AI ISA (m197, lead qualification/nurture) +
 * Data Steward (m203, data integrity / identity / field stewardship across the lead spine).
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
  sphere_of_influence:   { key: "sphere_of_influence",   label: "Sphere Manager",        domain: "Database, repeat & referral" },
  campaign_orchestrator: { key: "campaign_orchestrator", label: "Campaign Orchestrator", domain: "Multi-touch campaigns & content" },
  marketing_agent:       { key: "marketing_agent",       label: "Marketing Manager",     domain: "Brand & promotion" },
  asset_manager:         { key: "asset_manager",         label: "Asset Manager",         domain: "Media & brand library" },
  ads_manager:           { key: "ads_manager",           label: "Ads Manager",           domain: "Paid advertising" },
  ai_isa:                { key: "ai_isa",                label: "AI ISA",                domain: "Lead qualification, nurture & re-engagement" },
  data_steward:          { key: "data_steward",          label: "Data Steward",          domain: "Data integrity, identity & field stewardship" },
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
