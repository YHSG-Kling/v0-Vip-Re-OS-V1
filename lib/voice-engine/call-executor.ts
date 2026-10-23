/**
 * VOICE ENGINE: CALL EXECUTION
 * 
 * This module handles voice call initiation and metadata tracking.
 * 
 * IMPORTANT: Voice is a CHANNEL, not intelligence.
 * - We execute calls but don't decide when they happen
 * - We record metadata but don't analyze content
 * - We integrate with vendors but don't route calls
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface CallMetadata {
  contactId: string
  initiatorRole: 'ai' | 'agent' | 'contact' | 'office'
  callType: 'inbound' | 'outbound'
  vendor: string // e.g., 'twilio', 'bland_ai', 'retell_ai'
  agentId?: string
  transactionId?: string
  listingId?: string
}

export interface CallExecutionResult {
  success: boolean
  callId?: string
  vendorCallId?: string
  error?: string
}

/**
 * INITIATE VOICE CALL
 * 
 * Executes a voice call and records initial metadata.
 * Does NOT decide when calls should happen - that's upstream logic.
 */
export async function initiateVoiceCall(
  metadata: CallMetadata,
  phoneNumber: string
): Promise<CallExecutionResult> {
  try {
    const supabase = createServiceClient()

    // Validate contact exists and check call stop flag
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, brokerage_id, phone, call_stop_flag, dnc_status')
      .eq('id', metadata.contactId)
      .single()

    if (contactError || !contact) {
      return {
        success: false,
        error: 'Contact not found',
      }
    }

    // Hard stop: call_stop_flag blocks all outbound calls (inbound + outbound)
    if (contact.call_stop_flag === true) {
      return {
        success: false,
        error:
          'Call blocked — contact has requested no calls (call_stop_flag). Remove the flag in the contact record to resume calling.',
      }
    }

    // Hard stop: DNC blocks all outbound
    if (contact.dnc_status === true) {
      return {
        success: false,
        error: 'Call blocked — contact is on the Do Not Contact list.',
      }
    }

    // ── ENGINE: Twilio-native (the single voice lane). The Twilio lane runs the
    // same governance (TCPA + budget gates inside placeOutboundAiCall) on the
    // serverless turn engine and writes its own voice_calls ledger row. The
    // metadata.vendor field is retained for the sequence record only; every
    // outbound AI call is placed through Twilio. placeOutboundAiCall fails
    // honestly if Twilio creds are absent (no stub).
    let agentUserId: string | null = null
    if (metadata.agentId) {
      const { data: agentRow } = await supabase.from('agents').select('user_id').eq('id', metadata.agentId).maybeSingle()
      agentUserId = (agentRow as any)?.user_id ?? null
    }
    const { placeOutboundAiCall } = await import('@/lib/voice/twilio-outbound')
    const placed = await placeOutboundAiCall(supabase, {
      toNumber: phoneNumber,
      contactId: metadata.contactId,
      brokerageId: contact.brokerage_id,
      agentUserId,
      objective: 'Follow up with this contact for the agent: confirm what they need next (buying, selling, or a question), and offer to book time with the agent.',
      // ARMS THE AUTONOMY GATE. This is an UNATTENDED dial from the sequence
      // engine — no human is at a keyboard — so it must be held when the
      // campaign_orchestrator is outside its trust boundary (god switch, tenant
      // halt, posture, accuracy gate). SYSTEM_SOURCE_TO_MANAGER maps
      // 'sequence' → campaign_orchestrator; the gate is a no-op without it.
      systemSource: 'sequence',
    })
    if (!placed.ok) return { success: false, error: placed.error }
    return { success: true, callId: placed.voiceCallId ?? undefined, vendorCallId: placed.callSid }
  } catch (error: any) {
    console.error('[v0] [VOICE ENGINE] Error initiating call:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * COMPLETE VOICE CALL
 * 
 * Updates call metadata after completion.
 * Records duration for vendor cost tracking.
 */
export async function completeVoiceCall(
  callId: string,
  durationSeconds: number,
  status: 'completed' | 'failed' | 'no_answer' | 'busy'
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServiceClient()

    // Update activity with completion
    const { error: updateError } = await supabase
      .from('activities')
      .update({
        status: status === 'completed' ? 'completed' : 'cancelled',
        completed_at: new Date().toISOString(),
        duration_minutes: Math.ceil(durationSeconds / 60),
        notes: JSON.stringify({
          callStatus: status,
          durationSeconds,
        }),
      })
      .eq('id', callId)

    if (updateError) {
      console.error('[v0] [VOICE ENGINE] Failed to update call completion:', updateError)
      return {
        success: false,
        error: 'Failed to update call status',
      }
    }

    console.log(`[v0] [VOICE ENGINE] Call ${callId} completed with status: ${status}`)

    return { success: true }
  } catch (error: any) {
    console.error('[v0] [VOICE ENGINE] Error completing call:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}
