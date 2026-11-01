'use server'

/**
 * SYSTEM 6.1 - Intent Parser — now a thin adapter onto THE ONE INTENT INTERFACE (C17, wave 148 lane 148D).
 *
 * TOMBSTONE (§1.1, Law 2): parseLLMIntent (a gatewayChat prompt pinned to openai/gpt-4o-mini, booked to
 * no tenant — CLAUDE.md §5) and parseFallbackIntent (its keyword list) were one of FOUR intent classifiers
 * in the tree. SURVIVOR: lib/voice-admin/intent-interface.ts interpretIntent (COMMAND_SEEDS carry these
 * commands and their keywords; generate_cma and schedule_showing merged onto cma_generate /
 * appointment_schedule, schedule_open_house onto open_house_schedule — one key per idea, §6) +
 * lib/voice-admin/intent-interface-live.ts interpretIntentLive (the one expert prompt, booked to the
 * session tenant). What stays HERE is this layer's own contract: the ParsedIntent shape
 * handleVoiceCommand reads, and entity resolution (address → listing_id, name → contact_id) before
 * validateAuthority + validateReadiness + COMMAND_EXECUTORS — none of which changed.
 */

import { resolveEntities } from './resolve-entities'
import { getAgentContext } from '@/lib/identity/get-agent-context'

export interface ParsedIntent {
  intent_type: 'query' | 'execute'
  target_system: 'buyer' | 'seller' | 'showing' | 'cma' | 'communication' | 'general'
  target_action: string
  entities: {
    listing_id?: string
    buyer_id?: string
    contact_id?: string
    showing_id?: string
    [key: string]: any
  }
  parameters: Record<string, any>
  confidence: number
  requires_clarification?: boolean
  missing_parameters?: string[]
  disambiguation_options?: string[]
  clarification_message?: string
}

export interface ParseIntentResult {
  success: boolean
  intent?: ParsedIntent
  error?: string
}

interface ParseIntentRequest {
  raw_transcript: string
  user_id: string
  user_role: string
  brokerage_id: string
  context?: {
    current_listing_id?: string
    current_buyer_id?: string
    location?: string
  }
}

/** This layer's coarse system label for a command (informational — validateAuthority logs it). */
function systemFor(action: string): ParsedIntent['target_system'] {
  if (/^generate_/.test(action)) return 'cma'
  if (/showing/.test(action)) return 'showing'
  if (/buyer|financ|lender/.test(action)) return 'buyer'
  return 'seller'
}

/**
 * Parse natural language voice input into this layer's structured intent — through C17.
 * The identity is re-read from the SESSION (a "use server" export is a public endpoint — CLAUDE.md §4);
 * the request's user_id / brokerage_id are used only when they match it.
 */
export async function parseIntent(request: ParseIntentRequest): Promise<ParseIntentResult> {
  const { raw_transcript, context } = request
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) return { success: false, error: 'Unauthorized' }
    const { interpretIntentLive } = await import('@/lib/voice-admin/intent-interface-live')
    const interpretation = await interpretIntentLive({
      utterance: raw_transcript,
      modality: 'voice',
      actor: { userId: ctx.userId, userType: ctx.userType || null, platformRole: null, agentId: ctx.agentId },
      tenant: { brokerageId: ctx.brokerageId },
      screen: 'voice_center',
      context: { listingId: context?.current_listing_id ?? null, contactId: context?.current_buyer_id ?? null },
    })

    if (!interpretation.capability) {
      return { success: false, error: 'Could not understand command with sufficient confidence' }
    }
    if (!interpretation.authority_check.allowed) {
      return { success: false, error: interpretation.authority_check.reasons[0] ?? 'Not allowed' }
    }
    const action = interpretation.executors.command_layer
    if (!action) {
      // Understood, and another desk executes it: say the plan; the one affordance on this page finishes it.
      return {
        success: true,
        intent: {
          intent_type: 'query', target_system: 'general', target_action: 'intent_interface', entities: {}, parameters: interpretation.params,
          confidence: 0.9, requires_clarification: true,
          clarification_message: `${interpretation.plan.summary} Finish it on the command bar — it asks for anything missing and waits for your yes.`,
        },
      }
    }
    const route = (await import('@/lib/voice-admin/intent-interface')).intentRoute(interpretation.capability)
    const listingRef = interpretation.params.listing ?? null
    const address = interpretation.params.address ?? (listingRef && listingRef.startsWith('address:') ? listingRef.slice(8) : null)
    const parsed: ParsedIntent = {
      intent_type: route?.mutates ? 'execute' : 'query',
      target_system: systemFor(action),
      target_action: action,
      entities: {
        ...(address ? { address } : {}),
        ...(interpretation.params.contact_name ? { contact_name: interpretation.params.contact_name } : {}),
      },
      parameters: interpretation.params,
      confidence: interpretation.confidence === 'high' ? 0.9 : interpretation.confidence === 'medium' ? 0.7 : 0.4,
    }
    if (interpretation.missing.length > 0) {
      return { success: true, intent: { ...parsed, requires_clarification: true, missing_parameters: interpretation.missing.map((m) => m.param), clarification_message: interpretation.missing[0].ask } }
    }
    return await enrichIntentWithEntities(parsed, ctx.userId, ctx.brokerageId, context)
  } catch (error) {
    console.error('[parse-intent] Error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Intent parsing failed'
    }
  }
}

/**
 * Enrich intent with resolved entity IDs
 */
async function enrichIntentWithEntities(
  intent: ParsedIntent,
  userId: string,
  brokerageId: string,
  context?: Record<string, any>
): Promise<ParseIntentResult> {
  // Resolve entities (address → listing_id, contact name → contact_id)
  const entityResult = await resolveEntities({
    entities: intent.entities,
    user_id: userId,
    brokerage_id: brokerageId,
    context
  })

  if (!entityResult.success) {
    return {
      success: false,
      error: entityResult.error
    }
  }

  // Check if clarification needed
  if (entityResult.requires_clarification) {
    return {
      success: true,
      intent: {
        ...intent,
        requires_clarification: true,
        disambiguation_options: entityResult.disambiguation_options,
        clarification_message: entityResult.clarification_message
      }
    }
  }

  // Update intent with resolved entity IDs
  return {
    success: true,
    intent: {
      ...intent,
      entities: entityResult.resolved_entities || intent.entities
    }
  }
}
