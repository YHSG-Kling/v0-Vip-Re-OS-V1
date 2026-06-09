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
 * All 9 managers mirror managed_agents.agent_kind (lib/agents/spawn-helper.ts AgentKind):
 * the 7 core managers + Ads Manager (m193) + AI ISA (m197, lead qualification/nurture).
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
