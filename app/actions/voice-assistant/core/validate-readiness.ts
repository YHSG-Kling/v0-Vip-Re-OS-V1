'use server'

/**
 * SYSTEM 6.1 - Readiness Validation
 * Validates system readiness using lifecycle events
 * NO column checks - events only per contract
 */

import { createClient } from '@/lib/supabase/server'
import { READINESS_RULES } from '../helpers/readiness-rules'

export interface ReadinessValidationResult {
  ready: boolean
  blocker_description?: string
  missing_events?: string[]
}

interface ValidateReadinessRequest {
  target_action: string
  entities: Record<string, any>
  brokerage_id: string
}

/**
 * Validate readiness using lifecycle events from activities table
 */
export async function validateReadiness(request: ValidateReadinessRequest): Promise<ReadinessValidationResult> {
  const { target_action, entities, brokerage_id } = request

  try {
    // Get readiness rules for action
    const rules = READINESS_RULES[target_action as keyof typeof READINESS_RULES]

    if (!rules) {
      // No readiness rules - allow by default
      return { ready: true }
    }

    // Check required events exist
    const missingEvents: string[] = []
    const supabase = await createClient()

    for (const requiredEvent of rules.required_events) {
      const hasEvent = await checkEventExists(
        requiredEvent,
        entities,
        brokerage_id,
        supabase
      )

      if (!hasEvent) {
        missingEvents.push(requiredEvent)
      }
    }

    if (missingEvents.length > 0) {
      return {
        ready: false,
        blocker_description: generateBlockerMessage(target_action, missingEvents),
        missing_events: missingEvents
      }
    }

    return { ready: true }

  } catch (error) {
    console.error('[validate-readiness] Error:', error)
    // Fail closed - don't allow if validation fails
    return {
      ready: false,
      blocker_description: 'Readiness validation failed'
    }
  }
}

/**
 * Check if event exists in activities table
 */
async function checkEventExists(
  eventType: string,
  entities: Record<string, any>,
  brokerageId: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<boolean> {
  let query = supabase
    .from('activities')
    .select('id')
    .eq('brokerage_id', brokerageId)
    .eq('activity_type', eventType)

  // Filter by entity if provided
  if (entities.listing_id) {
    query = query.eq('listing_id', entities.listing_id)
  }

  if (entities.buyer_id) {
    query = query.eq('contact_id', entities.buyer_id)
  }

  const { data } = await query.limit(1).single()

  return !!data
}

/**
 * Generate human-friendly blocker message
 */
function generateBlockerMessage(action: string, missingEvents: string[]): string {
  const actionFriendly = action.replace(/_/g, ' ')
  const eventFriendly = missingEvents.map(e => e.replace(/\./g, ' ').replace(/_/g, ' ')).join(', ')

  return `Cannot ${actionFriendly}. Missing: ${eventFriendly}`
}
