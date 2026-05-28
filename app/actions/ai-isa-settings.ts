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
import {
  type AIISASettings,
  type IsaCapability,
  type IsaCapabilityDescriptor,
  DEFAULT_AISA_SETTINGS,
  ISA_CAPABILITY_CATALOG,
  defaultEnabledCapabilities,
} from '@/lib/ai-isa/settings-types'

// ── Roles allowed to write settings ─────────────────────────────────────────
const WRITE_ROLES = new Set(['broker', 'broker_admin', 'admin', 'superadmin'])

// Capability catalog + defaults moved to @/lib/ai-isa/settings-types (no
// "use server", so it can be imported from client components directly).

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
