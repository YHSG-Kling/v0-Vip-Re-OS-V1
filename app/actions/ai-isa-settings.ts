'use server'

/**
 * app/actions/ai-isa-settings.ts
 *
 * Brokerage-wide AI ISA configuration.
 *
 * Storage: global_settings.additional_settings->>'ai_isa_settings' (JSONB)
 * Access: broker, admin, superadmin only. Agents may read, not write.
 *
 * Settings shape: AIISASettings (see below)
 */

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getAgentContext } from '@/lib/identity/get-agent-context'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AIISASettings {
  /** Master on/off for the entire brokerage */
  enabled: boolean
  /** Allowed outbound channels for LEADS (no TCPA) */
  lead_allowed_channels: ('email' | 'direct_mail')[]
  /** Allowed outbound channels for CONTACTS with consent */
  contact_allowed_channels: ('email' | 'sms' | 'phone' | 'direct_mail')[]
  /** Days with no contact before a contact is flagged as stale */
  stale_threshold_days: number
  /** Days with no reply after outreach before ghosted flag */
  ghosted_threshold_days: number
  /** Maximum outreach touches before AI ISA stops */
  max_touches_lead: number
  max_touches_contact: number
  /** Cadence: days between touches */
  touch_interval_days: number
  /** Lifecycle states where AI ISA is blocked on contacts */
  blocked_lifecycle_states: string[]
  /** Whether to auto-enable AI ISA on newly-captured contacts */
  auto_enable_on_new_contacts: boolean
  /** Whether to pause AI ISA when agent is assigned */
  pause_on_agent_assigned: boolean
  /** Default handoff action when qualifying outcome is reached */
  default_handoff_action: 'notify_agent' | 'create_task' | 'both'
  /** Suppress automation after these negative outcomes */
  suppress_on_outcomes: string[]
  /**
   * Per-brokerage capability allowlist. Each ISA function tool checks
   * isCapabilityEnabled(brokerageId, capability) before executing. When
   * undefined, falls back to defaultEnabledCapabilities().
   */
  enabled_capabilities?: IsaCapability[]
  /**
   * Predictive Listing auto-send tuning. All optional — sensible defaults
   * apply when undefined. Only consulted when capability
   * `predictive_listing_auto_touch` is enabled.
   */
  pls_auto_send_score_threshold?: number          // default 75
  pls_auto_send_review_window_hours?: number      // default 24, set 0 for immediate send
  pls_auto_send_cooldown_days?: number            // default 90 — don't auto-touch same contact more than once per quarter
  pls_auto_send_max_per_day?: number              // default 5 — global per-brokerage daily rate limit
  pls_auto_send_eligible_channels?: ("email" | "sms")[] // default ['email'] — SMS requires explicit opt-in
}

export const DEFAULT_AISA_SETTINGS: AIISASettings = {
  enabled: true,
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

// ── Roles allowed to write settings ─────────────────────────────────────────
const WRITE_ROLES = new Set(['broker', 'broker_admin', 'admin', 'superadmin'])

// ── ISA Function Tool Capabilities ──────────────────────────────────────────
//
// Each capability is a discrete action the AI ISA can perform during a call
// or conversation. Brokerages opt in per capability — the AI will refuse any
// function-call whose capability is disabled. Defaults are conservative
// (only the safest capabilities enabled out of the box).

export type IsaCapability =
  // Core qualification flow — always allowed when ISA is enabled
  | "qualify_lead"
  | "record_outcome"
  | "transfer_to_agent"
  // Outreach
  | "send_email"
  | "send_sms"
  | "send_property_listings"
  | "send_market_update"
  // Booking
  | "book_appointment"
  | "book_listing_consultation"
  | "request_showing_in_house_listing"
  // Compliance / dnc
  | "process_opt_out"
  | "honor_dnc_request"
  // Information actions
  | "answer_listing_status"
  | "answer_transaction_status"
  | "answer_home_value_estimate"
  | "answer_documents_status"
  // Ghost re-engagement
  | "ghost_recovery_outreach"
  // Review / reputation
  | "send_review_request"
  // Predictive Listing auto-send
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
  // Core
  { key: "qualify_lead", label: "Qualify lead", description: "Run qualification scripts, capture timeline/budget/motivation/lender status.", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "record_outcome", label: "Record call outcome", description: "Log call/conversation outcome (qualified, not_ready_now, opt_out, etc.).", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "transfer_to_agent", label: "Transfer call to live agent", description: "Hot-transfer the call to the assigned agent or duty agent when caller asks for a human or ISA can't resolve.", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  // Outreach
  { key: "send_email", label: "Send outbound email", description: "Send qualification or follow-up emails. Required for unconsented leads (email is one of two allowed channels).", category: "outreach", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "send_sms", label: "Send outbound SMS", description: "Send SMS messages. ONLY runs against consented contacts — TCPA-gated regardless of this toggle.", category: "outreach", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  { key: "send_property_listings", label: "Send matched property listings", description: "Text or email a list of matched properties to qualified buyers.", category: "outreach", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  { key: "send_market_update", label: "Send local market update", description: "Send seller/lifetime customer their personalized monthly market snapshot.", category: "outreach", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  // Booking
  { key: "book_appointment", label: "Book agent consultation", description: "Schedule a buyer or seller consultation with the assigned agent on their calendar.", category: "booking", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "book_listing_consultation", label: "Book listing appointment", description: "Schedule a listing consultation specifically (price strategy, walkthrough, etc.).", category: "booking", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "request_showing_in_house_listing", label: "Request showing on in-house listing (unrepresented buyer)", description: "ONLY for IN-HOUSE listings + buyers without an agent. Finds availability with the listing agent and books the showing. Will NOT book on cooperating brokerage listings or for represented buyers.", category: "booking", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  // Compliance
  { key: "process_opt_out", label: "Process opt-out / DNC", description: "Detect and honor opt-out requests immediately (writes to platform_suppression_list).", category: "compliance", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "honor_dnc_request", label: "Honor DNC request mid-call", description: "End call gracefully and add caller to DNC if they request to be removed.", category: "compliance", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  // Information
  { key: "answer_listing_status", label: "Answer 'what's the status of my listing?'", description: "Look up the contact's listing and report current stage, recent activity, showings, offers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_transaction_status", label: "Answer 'what's the status of my closing?'", description: "Look up the contact's transaction and report milestones, deadlines, blockers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_home_value_estimate", label: "Answer 'what's my home worth?'", description: "Run a quick AVM and report current estimated home value to lifetime customers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: false },
  { key: "answer_documents_status", label: "Answer 'where are we on documents?'", description: "Report compliance and document checklist status for the contact's active transaction.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  // Ghost / re-engagement
  { key: "ghost_recovery_outreach", label: "Run ghost recovery sequence", description: "Re-engage contacts who have gone quiet (after configured ghosted_threshold_days).", category: "ghost", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  // Reputation
  { key: "send_review_request", label: "Send review request post-close", description: "Auto-send the post-close review request to lifetime customers.", category: "reputation", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  // Predictive Listing Auto-Touch (high-value automation, opt-in)
  { key: "predictive_listing_auto_touch", label: "Auto-send touches to likely sellers", description: "When a contact's Predictive Listing Score crosses the threshold, automatically queue a soft check-in touch (with configurable review window). Sensitive life events (divorce, foreclosure, death) are always excluded — those require human judgement.", category: "outreach", requiresConsent: true, riskLevel: "high", defaultEnabled: false },
]

/**
 * Default capability set when no per-brokerage config exists.
 */
export function defaultEnabledCapabilities(): IsaCapability[] {
  return ISA_CAPABILITY_CATALOG.filter((c) => c.defaultEnabled).map((c) => c.key)
}

/**
 * Permission check used by every ISA function tool handler. Reads the
 * brokerage's enabled_capabilities from settings; falls back to defaults.
 *
 * Returns true when the capability is explicitly enabled OR is one of the
 * always-on core capabilities.
 */
export async function isCapabilityEnabled(
  brokerageId: string,
  capability: IsaCapability
): Promise<boolean> {
  const settings = await getAIISASettings(brokerageId)

  // ISA is master-disabled at the brokerage — refuse everything
  if (settings.enabled === false) return false

  const enabled =
    (settings.enabled_capabilities as IsaCapability[] | undefined) ??
    defaultEnabledCapabilities()

  return enabled.includes(capability)
}

// ── getAIISASettings ──────────────────────────────────────────────────────────

export async function getAIISASettings(brokerageId: string): Promise<AIISASettings> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('global_settings')
    .select('additional_settings')
    .eq('brokerage_id', brokerageId)
    .maybeSingle()

  if (!data?.additional_settings?.ai_isa_settings) {
    return DEFAULT_AISA_SETTINGS
  }

  // Deep merge so newly added keys always have defaults
  return {
    ...DEFAULT_AISA_SETTINGS,
    ...(data.additional_settings.ai_isa_settings as Partial<AIISASettings>),
  }
}

// ── saveAIISASettings ─────────────────────────────────────────────────────────

export async function saveAIISASettings(
  brokerageId: string,
  updates: Partial<AIISASettings>,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const ctx = await getAgentContext()

  if (!ctx || !WRITE_ROLES.has(ctx.role)) {
    return { success: false, error: 'Insufficient permissions' }
  }
  if (ctx.brokerageId !== brokerageId && ctx.role !== 'superadmin') {
    return { success: false, error: 'Brokerage mismatch' }
  }

  const service = createServiceClient()

  // Fetch current additional_settings
  const { data: existing } = await service
    .from('global_settings')
    .select('id, additional_settings')
    .eq('brokerage_id', brokerageId)
    .maybeSingle()

  if (!existing) {
    return { success: false, error: 'Global settings row not found for this brokerage' }
  }

  const currentISA = (existing.additional_settings?.ai_isa_settings ?? {}) as Partial<AIISASettings>
  const merged = { ...DEFAULT_AISA_SETTINGS, ...currentISA, ...updates }

  const { error } = await service
    .from('global_settings')
    .update({
      additional_settings: {
        ...(existing.additional_settings ?? {}),
        ai_isa_settings: merged,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)

  if (error) return { success: false, error: error.message }

  return { success: true }
}

// ── getAIISAStats ─────────────────────────────────────────────────────────────
// Dashboard-level stats for the admin/broker ISA reporting surface.

export async function getAIISAStats(brokerageId: string): Promise<{
  activeContactCount: number
  activeLeadCount: number
  staleContactCount: number
  handoffRequiredCount: number
  outreachLast30Days: number
  negativeOutcomeLast30Days: number
}> {
  const supabase = createServiceClient()
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const staleDate = new Date(Date.now() - 14 * 86_400_000).toISOString()

  const [
    activeContacts,
    activeLeads,
    staleContacts,
    handoffs,
    outreach,
    negativeOutcomes,
  ] = await Promise.all([
    // Contacts where ISA is enabled
    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('ai_outreach_paused', false)
      .eq('isa_reengage_allowed', true)
      .is('deleted_at', null),

    // Leads still in AI ISA owner queue
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('ai_isa_owner', true)
      .eq('is_active', true),

    // Stale contacts
    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('ai_outreach_paused', false)
      .lt('last_contacted_at', staleDate)
      .is('deleted_at', null),

    // Handoffs awaiting human
    supabase
      .from('agent_handoffs')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('handoff_status', 'pending'),

    // Outreach in last 30 days (contact-side)
    supabase
      .from('ai_isa_activities')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .gte('created_at', since30),

    // Negative outcomes in last 30 days
    supabase
      .from('ai_isa_activities')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .in('outcome', ['not_interested', 'wrong_number', 'do_not_contact', 'do_not_call', 'bad_contact_data'])
      .gte('created_at', since30),
  ])

  return {
    activeContactCount:      activeContacts.count  ?? 0,
    activeLeadCount:         activeLeads.count     ?? 0,
    staleContactCount:       staleContacts.count   ?? 0,
    handoffRequiredCount:    handoffs.count         ?? 0,
    outreachLast30Days:      outreach.count         ?? 0,
    negativeOutcomeLast30Days: negativeOutcomes.count ?? 0,
  }
}
