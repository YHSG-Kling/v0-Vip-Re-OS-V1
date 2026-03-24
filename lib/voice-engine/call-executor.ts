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

    // Validate contact exists
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, brokerage_id, phone')
      .eq('id', metadata.contactId)
      .single()

    if (contactError || !contact) {
      return {
        success: false,
        error: 'Contact not found',
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

    // Credentials are present. The real outbound call API invocation belongs here.
    // Until the vendor SDK integration is wired, surface an honest error rather than
    // logging a phantom activity row with a fake vendor ID.
    // vendorCallId MUST come from the real API response — never manufactured locally.
    return {
      success: false,
      error: `Voice provider "${metadata.vendor}" credentials are configured but the outbound call integration is not yet wired. No call was placed and no activity was logged.`,
      vendorCallId: undefined,
    }

    // Log call initiation as activity
    const { data: activity, error: activityError } = await supabase
      .from('activities')
      .insert({
        activity_type: 'voice_call_initiated',
        title: `Voice Call: ${metadata.callType}`,
        description: `${metadata.initiatorRole} initiated ${metadata.callType} call`,
        status: 'in_progress',
        priority: 'normal',
        contact_id: metadata.contactId,
        agent_id: metadata.agentId,
        transaction_id: metadata.transactionId,
        notes: JSON.stringify({
          vendor: metadata.vendor,
          vendorCallId,
          phoneNumber,
        }),
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (activityError) {
      console.error('[v0] [VOICE ENGINE] Failed to log call initiation:', activityError)
      return {
        success: false,
        error: 'Failed to log call initiation',
      }
    }

    return {
      success: true,
      callId: activity?.id,
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
