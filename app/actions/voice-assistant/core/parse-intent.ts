'use server'

/**
 * SYSTEM 6.1 - Intent Parser
 * Parses natural language voice input into structured intent using LLM
 */

import { createClient } from '@/lib/supabase/server'
import { resolveEntities } from './resolve-entities'
import { gatewayChat } from "@/lib/ai/gateway-chat"

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

/**
 * Parse natural language voice input into structured intent
 * Uses LLM for classification with fallback to keyword matching
 */
export async function parseIntent(request: ParseIntentRequest): Promise<ParseIntentResult> {
  const { raw_transcript, user_id, user_role, brokerage_id, context } = request

  try {
    // Use LLM to parse intent
    const llmResult = await parseLLMIntent(raw_transcript, context)

    if (llmResult.confidence < 0.6) {
      // Low confidence - try fallback
      const fallbackResult = parseFallbackIntent(raw_transcript)
      if (fallbackResult.confidence >= 0.6) {
        return await enrichIntentWithEntities(fallbackResult, user_id, brokerage_id, context)
      }

      return {
        success: false,
        error: 'Could not understand command with sufficient confidence'
      }
    }

    // Enrich with entity resolution
    return await enrichIntentWithEntities(llmResult, user_id, brokerage_id, context)

  } catch (error) {
    console.error('[parse-intent] Error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Intent parsing failed'
    }
  }
}

/**
 * Use LLM to parse intent (OpenAI/Anthropic)
 */
async function parseLLMIntent(
  transcript: string,
  context?: Record<string, any>
): Promise<ParsedIntent> {
  const systemPrompt = `You are a voice command parser for a real estate CRM system.
Parse the user's voice command and extract:
- intent_type: "query" (asking for information) or "execute" (performing an action)
- target_system: "buyer", "seller", "showing", "cma", "communication", or "general"
- target_action: specific action like "generate_cma", "schedule_showing", "activate_mls"
- entities: extract any mentioned addresses, contact names, listing IDs
- parameters: extract any dates, times, amounts, or other parameters

Return JSON only, no additional text.`

  const userPrompt = `Parse this voice command:
"${transcript}"

Context: ${JSON.stringify(context || {})}

Examples of target_action values:
- generate_cma
- generate_net_sheet
- generate_presentation
- schedule_appointment
- schedule_media
- approve_media
- activate_mls
- submit_to_mls
- schedule_showing
- query_listing_status
- query_buyer_stage
- send_agreement

Return format:
{
  "intent_type": "query" | "execute",
  "target_system": "buyer" | "seller" | "showing" | "cma" | "communication" | "general",
  "target_action": "specific_action",
  "entities": {
    "address": "123 Main St",
    "contact_name": "John Smith"
  },
  "parameters": {},
  "confidence": 0.95
}`

  try {
    const response = await gatewayChat({
      model: 'openai/gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    })

    if (!response.ok) {
      throw new Error('LLM API call failed')
    }

    const content = response.content

    if (!content) {
      throw new Error('No response from LLM')
    }

    // Parse JSON response
    const parsed = JSON.parse(content)

    return {
      intent_type: parsed.intent_type,
      target_system: parsed.target_system,
      target_action: parsed.target_action,
      entities: parsed.entities || {},
      parameters: parsed.parameters || {},
      confidence: parsed.confidence || 0.7
    }

  } catch (error) {
    console.error('[parseLLMIntent] Error:', error)
    // Return low confidence so fallback can be used
    return {
      intent_type: 'query',
      target_system: 'general',
      target_action: 'unknown',
      entities: {},
      parameters: {},
      confidence: 0.3
    }
  }
}

/**
 * Fallback intent parser using keyword matching
 */
function parseFallbackIntent(transcript: string): ParsedIntent {
  const lower = transcript.toLowerCase()

  // CMA generation
  if (lower.includes('generate cma') || lower.includes('create cma') || lower.includes('make cma')) {
    return {
      intent_type: 'execute',
      target_system: 'cma',
      target_action: 'generate_cma',
      entities: {},
      parameters: {},
      confidence: 0.8
    }
  }

  // Net sheet
  if (lower.includes('net sheet') || lower.includes('seller proceeds')) {
    return {
      intent_type: 'execute',
      target_system: 'cma',
      target_action: 'generate_net_sheet',
      entities: {},
      parameters: {},
      confidence: 0.8
    }
  }

  // Listing status queries
  if (lower.includes('listing status') || lower.includes('where is') || lower.includes('what stage')) {
    return {
      intent_type: 'query',
      target_system: 'seller',
      target_action: 'query_listing_status',
      entities: {},
      parameters: {},
      confidence: 0.75
    }
  }

  // Buyer status queries
  if (lower.includes('buyer status') || lower.includes('buyer stage') || lower.includes('buyer progress')) {
    return {
      intent_type: 'query',
      target_system: 'buyer',
      target_action: 'query_buyer_stage',
      entities: {},
      parameters: {},
      confidence: 0.75
    }
  }

  // MLS activation
  if (lower.includes('activate mls') || lower.includes('submit to mls')) {
    return {
      intent_type: 'execute',
      target_system: 'seller',
      target_action: 'activate_mls',
      entities: {},
      parameters: {},
      confidence: 0.75
    }
  }

  // Schedule showing
  if (lower.includes('schedule showing') || lower.includes('book showing')) {
    return {
      intent_type: 'execute',
      target_system: 'showing',
      target_action: 'schedule_showing',
      entities: {},
      parameters: {},
      confidence: 0.7
    }
  }

  // Default: unknown
  return {
    intent_type: 'query',
    target_system: 'general',
    target_action: 'unknown',
    entities: {},
    parameters: {},
    confidence: 0.4
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
