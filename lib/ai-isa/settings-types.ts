/**
 * Pure types + constants for AI ISA settings. Lives outside the
 * "use server" action file so client components can import the types
 * and the read-only catalogs/defaults without RPC overhead and without
 * the "Server Actions must be async functions" build constraint.
 */

export interface AIISASettings {
  enabled: boolean
  /**
   * THE AUTO-SEND GATE. `true` (the default, and the live column default) means
   * the ISA may DRAFT a touch but a human must release it; `false` means the
   * brokerage has explicitly authorised the ISA to send on its behalf.
   *
   * BUILT, not invented (CLAUDE.md §1 case 2). `ai_isa_settings.require_broker_approval`
   * has existed since migration 061 (`BOOLEAN NOT NULL DEFAULT TRUE`), is named in
   * the resolver's SELECT list, and had NO reader that acted on it and NO writer
   * that set it — the one thing a broker would look for before letting an AI mail
   * their leads was a column nothing consulted. `rowToSettings` in
   * lib/ai-isa/resolve-isa-settings.ts now folds it in the same way it folds
   * `is_active` → `enabled`: the COLUMN is authoritative over anything stale in
   * the `settings` blob (§6 — one spelling per idea).
   *
   * The DEFAULT is `true` because the failure that matters on this path is sending
   * on someone's behalf without their configured consent (CLAUDE.md §4). A
   * brokerage with no settings row at any tier gets staged drafts, not sends.
   */
  require_broker_approval: boolean
  lead_allowed_channels: ('email' | 'direct_mail')[]
  contact_allowed_channels: ('email' | 'sms' | 'phone' | 'direct_mail')[]
  stale_threshold_days: number
  ghosted_threshold_days: number
  max_touches_lead: number
  max_touches_contact: number
  touch_interval_days: number
  blocked_lifecycle_states: string[]
  auto_enable_on_new_contacts: boolean
  pause_on_agent_assigned: boolean
  default_handoff_action: 'notify_agent' | 'create_task' | 'both'
  suppress_on_outcomes: string[]
  enabled_capabilities?: IsaCapability[]
  pls_auto_send_score_threshold?: number
  pls_auto_send_review_window_hours?: number
  pls_auto_send_cooldown_days?: number
  pls_auto_send_max_per_day?: number
  pls_auto_send_eligible_channels?: ("email" | "sms")[]
}

export const DEFAULT_AISA_SETTINGS: AIISASettings = {
  enabled: true,
  // FAIL CLOSED (§4). Matches the live column default (`NOT NULL DEFAULT TRUE`,
  // migration 061): "nobody configured this" renders as "a human releases it",
  // never as "the AI may send".
  require_broker_approval: true,
  lead_allowed_channels: ['email', 'direct_mail'],
  contact_allowed_channels: ['email', 'sms', 'phone', 'direct_mail'],
  stale_threshold_days: 14,
  ghosted_threshold_days: 21,
  max_touches_lead: 5,
  max_touches_contact: 8,
  touch_interval_days: 3,
  blocked_lifecycle_states: ['representation', 'active_transaction', 'closing', 'do_not_contact'],
  auto_enable_on_new_contacts: false,
  pause_on_agent_assigned: true,
  default_handoff_action: 'both',
  suppress_on_outcomes: ['not_interested', 'do_not_contact', 'do_not_call', 'wrong_number'],
}

export type IsaCapability =
  | "qualify_lead"
  | "record_outcome"
  | "transfer_to_agent"
  | "send_email"
  | "send_sms"
  | "send_property_listings"
  | "send_market_update"
  | "book_appointment"
  | "book_listing_consultation"
  | "request_showing_in_house_listing"
  | "process_opt_out"
  | "honor_dnc_request"
  | "answer_listing_status"
  | "answer_transaction_status"
  | "answer_home_value_estimate"
  | "answer_documents_status"
  | "ghost_recovery_outreach"
  | "send_review_request"
  | "predictive_listing_auto_touch"

export interface IsaCapabilityDescriptor {
  key: IsaCapability
  label: string
  description: string
  category: "core" | "outreach" | "booking" | "compliance" | "information" | "ghost" | "reputation"
  requiresConsent: boolean
  riskLevel: "low" | "medium" | "high"
  defaultEnabled: boolean
}

export const ISA_CAPABILITY_CATALOG: IsaCapabilityDescriptor[] = [
  { key: "qualify_lead", label: "Qualify lead", description: "Run qualification scripts, capture timeline/budget/motivation/lender status.", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "record_outcome", label: "Record call outcome", description: "Log call/conversation outcome (qualified, not_ready_now, opt_out, etc.).", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "transfer_to_agent", label: "Transfer call to live agent", description: "Hot-transfer the call to the assigned agent or duty agent when caller asks for a human or ISA can't resolve.", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "send_email", label: "Send outbound email", description: "Send qualification or follow-up emails. Required for unconsented leads (email is one of two allowed channels).", category: "outreach", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "send_sms", label: "Send outbound SMS", description: "Send SMS messages. ONLY runs against consented contacts — TCPA-gated regardless of this toggle.", category: "outreach", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  { key: "send_property_listings", label: "Send matched property listings", description: "Text or email a list of matched properties to qualified buyers.", category: "outreach", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  { key: "send_market_update", label: "Send local market update", description: "Send seller/lifetime customer their personalized monthly market snapshot.", category: "outreach", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  { key: "book_appointment", label: "Book agent consultation", description: "Schedule a buyer or seller consultation with the assigned agent on their calendar.", category: "booking", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "book_listing_consultation", label: "Book listing appointment", description: "Schedule a listing consultation specifically (price strategy, walkthrough, etc.).", category: "booking", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "request_showing_in_house_listing", label: "Request showing on in-house listing (unrepresented buyer)", description: "ONLY for IN-HOUSE listings + buyers without an agent. Finds availability with the listing agent and books the showing. Will NOT book on cooperating brokerage listings or for represented buyers.", category: "booking", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  { key: "process_opt_out", label: "Process opt-out / DNC", description: "Detect and honor opt-out requests immediately (writes to platform_suppression_list).", category: "compliance", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "honor_dnc_request", label: "Honor DNC request mid-call", description: "End call gracefully and add caller to DNC if they request to be removed.", category: "compliance", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_listing_status", label: "Answer 'what's the status of my listing?'", description: "Look up the contact's listing and report current stage, recent activity, showings, offers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_transaction_status", label: "Answer 'what's the status of my closing?'", description: "Look up the contact's transaction and report milestones, deadlines, blockers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_home_value_estimate", label: "Answer 'what's my home worth?'", description: "Run a quick AVM and report current estimated home value to lifetime customers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: false },
  { key: "answer_documents_status", label: "Answer 'where are we on documents?'", description: "Report compliance and document checklist status for the contact's active transaction.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "ghost_recovery_outreach", label: "Run ghost recovery sequence", description: "Re-engage contacts who have gone quiet (after configured ghosted_threshold_days).", category: "ghost", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  { key: "send_review_request", label: "Send review request post-close", description: "Auto-send the post-close review request to lifetime customers.", category: "reputation", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  { key: "predictive_listing_auto_touch", label: "Auto-send touches to likely sellers", description: "When a contact's Predictive Listing Score crosses the threshold, automatically queue a soft check-in touch (with configurable review window). Sensitive life events (divorce, foreclosure, death) are always excluded — those require human judgement.", category: "outreach", requiresConsent: true, riskLevel: "high", defaultEnabled: false },
]

/** Default capability set when no per-brokerage config exists. */
export function defaultEnabledCapabilities(): IsaCapability[] {
  return ISA_CAPABILITY_CATALOG.filter((c) => c.defaultEnabled).map((c) => c.key)
}
