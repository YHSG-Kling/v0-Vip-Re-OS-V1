'use server'

/**
 * SYSTEM 6.1 - Audit Event Emitter
 * Emits voice command events to activities table for complete audit trail
 */

import { createClient } from '@/lib/supabase/server'

export interface EmitAuditEventRequest {
  event_type: 'voice.command.executed' | 'voice.command.failed' | 'voice.command.clarification_needed'
  user_id: string
  brokerage_id: string
  entity_type?: 'listing' | 'contact' | 'showing'
  entity_id?: string
  metadata: Record<string, any>
}

// Agent task (correct location, no changes) — activity_type: voice.command.executed, voice.command.failed, voice.command.clarification_needed
/**
 * Emit voice command audit event to activities table
 */
export async function emitAuditEvent(request: EmitAuditEventRequest): Promise<{ success: boolean; error?: string }> {
  const { event_type, user_id, brokerage_id, entity_type, entity_id, metadata } = request

  try {
    const supabase = await createClient()

    // Build activity record
    const activity: any = {
      brokerage_id,
      user_id,
      activity_type: event_type,
      status: event_type === 'voice.command.executed' ? 'completed' : 'failed',
      metadata: {
        ...metadata,
        timestamp: new Date().toISOString()
      }
    }

    // Add entity references if provided
    if (entity_type === 'listing' && entity_id) {
      activity.listing_id = entity_id
    } else if (entity_type === 'contact' && entity_id) {
      activity.contact_id = entity_id
    }

    // Insert activity
    const { error } = await supabase.from('activities').insert(activity)

    if (error) {
      console.error('[emit-audit-event] Error:', error)
      return { success: false, error: error.message }
    }

    return { success: true }

  } catch (error) {
    console.error('[emit-audit-event] Unexpected error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Audit event emission failed'
    }
  }
}
