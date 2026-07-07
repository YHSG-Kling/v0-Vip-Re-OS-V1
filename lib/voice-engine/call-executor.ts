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
import { initiateCall } from '@/lib/voice/vapi-client'

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

    // Guard: require real vendor credentials before attempting the call.
    // The vendor field in metadata drives which API key is checked.
    const isVapi = metadata.vendor === 'vapi' || metadata.vendor === 'vapi_isa'
    const isTwilio = metadata.vendor === 'twilio'

    if (isVapi && (!process.env.VAPI_API_KEY || !process.env.VAPI_ISA_ASSISTANT_ID)) {
      return {
        success: false,
        error: 'Voice provider not configured — call was not placed. Configure VAPI in Admin → Integrations.',
        vendorCallId: undefined,
      }
    }

    if (isTwilio && (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)) {
      return {
        success: false,
        error: 'Voice provider not configured — call was not placed. Configure Twilio in Admin → Integrations.',
        vendorCallId: undefined,
      }
    }

    if (!isVapi && !isTwilio) {
      // Unknown vendor — refuse to stub; surface the gap immediately
      return {
        success: false,
        error: `Voice provider "${metadata.vendor}" is not supported or not configured. No call was placed.`,
        vendorCallId: undefined,
      }
    }

    // ── ENGINE: Twilio-native by default (owner: "no longer vapi") ────────────
    // The Twilio lane runs the same governance (TCPA + budget gates inside
    // placeOutboundAiCall) on the serverless turn engine. VOICE_ENGINE=vapi
    // selects the legacy lane only during the migration window.
    if (process.env.VOICE_ENGINE !== 'vapi') {
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
      })
      if (!placed.ok) return { success: false, error: placed.error }
      return { success: true, callId: placed.voiceCallId ?? undefined, vendorCallId: placed.callSid }
    }

    // CALLER ID (LEGACY Vapi lane): dial FROM the agent's own Vapi-bound number
    // when one exists (the contact recognizes it; answer rates follow) — else
    // the platform fallback inside initiateCall. Best-effort, never blocks.
    let fromPhoneNumberId: string | null = null
    if (metadata.agentId) {
      try {
        const { data: agentRow } = await supabase.from('agents').select('user_id').eq('id', metadata.agentId).maybeSingle()
        const agentUserId = (agentRow as any)?.user_id
        if (agentUserId) {
          const { data: num } = await supabase
            .from('vapi_phone_numbers')
            .select('vapi_phone_number_id')
            .eq('agent_user_id', agentUserId)
            .eq('is_active', true)
            .not('vapi_phone_number_id', 'is', null)
            .limit(1)
            .maybeSingle()
          fromPhoneNumberId = (num as any)?.vapi_phone_number_id ?? null
        }
      } catch { /* fall back to the platform number */ }
    }

    // Initiate the real VAPI call via REST API
    let vapiResponse: { id: string; status: string; createdAt: string }
    try {
      vapiResponse = await initiateCall({
        phoneNumber,
        assistantId: process.env.VAPI_ISA_ASSISTANT_ID,
        contactId:   metadata.contactId,
        brokerageId: contact.brokerage_id,
        phoneNumberId: fromPhoneNumberId,
      })
    } catch (err: any) {
      console.error('[v0] [VOICE ENGINE] VAPI initiateCall failed:', err.message)
      return {
        success: false,
        error: `VAPI call failed: ${err.message}`,
      }
    }

    const vendorCallId = vapiResponse.id

    // Write call record to voice_calls for full transcript/analysis tracking
    const { data: voiceCall, error: voiceCallError } = await supabase
      .from('voice_calls')
      .insert({
        contact_id: metadata.contactId,
        agent_id: metadata.agentId ?? null,
        brokerage_id: contact.brokerage_id,
        vapi_call_id: vendorCallId,
        direction: metadata.callType,
        call_type: 'ai_isa_call',
        status: 'initiated',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (voiceCallError) {
      console.error('[v0] [VOICE ENGINE] Failed to write voice_calls row:', voiceCallError)
      // Call is live — don't fail, just warn
    }

    // Also write lightweight vapi_voice_calls row for superadmin billing roll-up
    await supabase.from('vapi_voice_calls').insert({
      voice_call_id: voiceCall?.id ?? null,
      brokerage_id: contact.brokerage_id,
      vapi_call_id: vendorCallId,
      assistant_id: process.env.VAPI_ISA_ASSISTANT_ID ?? null,
      agent_id: metadata.agentId ?? null,
      contact_id: metadata.contactId,
      ended_reason: null,
    })

    return {
      success: true,
      callId: voiceCall?.id,
      vendorCallId,
    }
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
