/**
 * VENDOR GOVERNANCE SYSTEM 2.4
 * Attribution Governance
 * 
 * WHY THIS EXISTS:
 * Every vendor usage event must be attributed to:
 * - Brokerage (required)
 * - Agent (when applicable)
 * - System (AI ISA, enrichment, voice, etc.)
 * 
 * This ensures:
 * - Multi-tenant cost isolation
 * - Proper billing/chargeback
 * - Audit trails for compliance
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface AttributionContext {
  brokerageId: string          // Required: which brokerage is using this
  agentId?: string             // Optional: which agent triggered it
  systemSource: string         // Required: which system made the call
  leadId?: string              // Optional: which lead this relates to
  contactId?: string           // Optional: which contact this relates to
  transactionId?: string       // Optional: which transaction this relates to
}

export interface AttributionValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * VALIDATE ATTRIBUTION
 * 
 * Ensures all usage events have proper attribution.
 * This is critical for multi-tenant isolation.
 */
export function validateAttribution(context: AttributionContext): AttributionValidation {
  const errors: string[] = []
  const warnings: string[] = []

  // Required: brokerage_id
  if (!context.brokerageId) {
    errors.push('Missing brokerageId (required for multi-tenant isolation)')
  }

  // Required: system_source
  if (!context.systemSource) {
    errors.push('Missing systemSource (required for tracking)')
  }

  // Warning: No agent attribution for agent-triggered action
  if (!context.agentId && context.systemSource.includes('agent')) {
    warnings.push('Agent-triggered action missing agentId attribution')
  }

  // Warning: No lead/contact attribution for outreach
  if (['ai_isa', 'email_outreach', 'voice_call'].includes(context.systemSource)) {
    if (!context.leadId && !context.contactId) {
      warnings.push('Outreach action missing lead/contact attribution')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * INFER ATTRIBUTION FROM CONTEXT
 * 
 * Attempts to infer missing attribution fields from database context.
 * Useful when upstream systems don't provide full attribution.
 * 
 * NOTE: This queries the database, so use sparingly.
 */
export async function inferAttribution(
  partial: Partial<AttributionContext>
): Promise<AttributionContext | null> {
  const supabase = createServiceClient()

  try {
    // If we have leadId, infer brokerage and agent
    if (partial.leadId) {
      const { data: lead } = await supabase
        .from('leads')
        .select('brokerage_id, agent_id')
        .eq('id', partial.leadId)
        .single()

      if (lead) {
        return {
          brokerageId: partial.brokerageId || lead.brokerage_id,
          agentId: partial.agentId || lead.agent_id || undefined,
          systemSource: partial.systemSource || 'unknown',
          leadId: partial.leadId,
          contactId: partial.contactId,
          transactionId: partial.transactionId,
        }
      }
    }

    // If we have contactId, infer brokerage and agent
    if (partial.contactId) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('brokerage_id, agent_id')
        .eq('id', partial.contactId)
        .single()

      if (contact) {
        return {
          brokerageId: partial.brokerageId || contact.brokerage_id,
          agentId: partial.agentId || contact.agent_id || undefined,
          systemSource: partial.systemSource || 'unknown',
          leadId: partial.leadId,
          contactId: partial.contactId,
          transactionId: partial.transactionId,
        }
      }
    }

    // If we have agentId, infer brokerage
    if (partial.agentId) {
      const { data: agent } = await supabase
        .from('agents')
        .select('brokerage_id')
        .eq('id', partial.agentId)
        .single()

      if (agent) {
        return {
          brokerageId: partial.brokerageId || agent.brokerage_id,
          agentId: partial.agentId,
          systemSource: partial.systemSource || 'unknown',
          leadId: partial.leadId,
          contactId: partial.contactId,
          transactionId: partial.transactionId,
        }
      }
    }

    return null
  } catch (error) {
    console.error('[v0] [VENDOR GOVERNANCE] Error inferring attribution:', error)
    return null
  }
}

/**
 * ATTRIBUTION HELPER: Get attribution for common scenarios
 */
export const SYSTEM_SOURCES = {
  AI_ISA: 'ai_isa',
  ENRICHMENT: 'enrichment',
  VOICE_CALL: 'voice_call',
  EMAIL_OUTREACH: 'email_outreach',
  DIRECT_MAIL: 'direct_mail',
  VIDEO_GENERATION: 'video_generation',
  AGENT_ACTION: 'agent_action',
  PIPELINE_PROCESSING: 'pipeline_processing',
  SCRAPING: 'scraping',
  ADMIN_ACTION: 'admin_action',
} as const
