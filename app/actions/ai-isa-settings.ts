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
