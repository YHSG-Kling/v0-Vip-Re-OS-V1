'use server'

/**
 * SYSTEM 3.3: VOICE ASSISTANT & CALL TRANSCRIPT ENGINE
 * Main Orchestrator
 * 
 * This system enables voice-based communication (AI and human).
 * Voice is treated as a CHANNEL, not intelligence.
 * 
 * RESPONSIBILITIES:
 * - Execute voice calls (inbound/outbound)
 * - Convert audio to text transcripts
 * - Write transcripts as messages via System 3.1
 * - Track vendor costs via System 2.4
 * - Emit signals for AI ISA to respond
 * 
 * NON-RESPONSIBILITIES:
 * - Call routing decisions
 * - Sentiment analysis
 * - Direct agent notifications
 * - Campaign orchestration
 * 
 * USAGE:
 * ```typescript
 * // After a voice call completes
 * await processVoiceCall({
 *   contactId: 'uuid',
 *   callMetadata: {
 *     vendor: 'bland_ai',
 *     callType: 'outbound',
 *     initiatorRole: 'ai',
 *     durationSeconds: 180,
 *   },
 *   rawTranscript: {
 *     segments: [
 *       { speaker: 'ai', text: 'Hello...', startTime: 0, endTime: 2 },
 *       { speaker: 'contact', text: 'Hi...', startTime: 2, endTime: 5 }
 *     ]
 *   }
 * })
 * ```
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  initiateVoiceCall,
  completeVoiceCall,
  ingestVoiceTranscript,
  emitVoiceHandoffSignal,
  trackVoiceCallUsage,
} from '@/lib/voice-engine'
import type { CallMetadata, RawTranscript } from '@/lib/voice-engine'

export interface ProcessVoiceCallParams {
  contactId: string
  callMetadata: {
    vendor: string
    callType: 'inbound' | 'outbound'
    initiatorRole: 'ai' | 'agent' | 'contact' | 'office'
    durationSeconds: number
    agentId?: string
    transactionId?: string
    listingId?: string
    phoneNumber?: string
  }
  rawTranscript?: RawTranscript
  callStatus?: 'completed' | 'failed' | 'no_answer' | 'busy'
}

export interface ProcessVoiceCallResult {
  success: boolean
  callId?: string
  messageId?: string
  conversationId?: string
  error?: string
}

/**
 * PROCESS VOICE CALL (Main Orchestrator)
 * 
 * Handles the complete voice call lifecycle:
 * 1. Initiate call (if new)
 * 2. Complete call with duration
 * 3. Ingest transcript via System 3.1
 * 4. Track vendor costs via System 2.4
 * 5. Emit AI ISA handoff signal
 */
export async function processVoiceCall(
  params: ProcessVoiceCallParams
): Promise<ProcessVoiceCallResult> {
  const supabase = createServiceClient()

  try {
    console.log(`[v0] [VOICE ENGINE] Processing ${params.callMetadata.callType} call for contact ${params.contactId}`)

    // STEP 1: Validate contact
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, brokerage_id, phone, first_name')
      .eq('id', params.contactId)
      .single()

    if (contactError || !contact) {
      return {
        success: false,
        error: 'Contact not found',
      }
    }

    // STEP 2: Initiate call (log metadata)
    const callMetadata: CallMetadata = {
      contactId: params.contactId,
      initiatorRole: params.callMetadata.initiatorRole,
      callType: params.callMetadata.callType,
      vendor: params.callMetadata.vendor,
      agentId: params.callMetadata.agentId,
      transactionId: params.callMetadata.transactionId,
      listingId: params.callMetadata.listingId,
    }

    const callResult = await initiateVoiceCall(
      callMetadata,
      params.callMetadata.phoneNumber || contact.phone || ''
    )

    if (!callResult.success || !callResult.callId) {
      return {
        success: false,
        error: `Failed to initiate call: ${callResult.error}`,
      }
    }

    const callId = callResult.callId

    // STEP 3: Complete call with duration
    const callStatus = params.callStatus || 'completed'
    await completeVoiceCall(callId, params.callMetadata.durationSeconds, callStatus)

    // STEP 4: If transcript available, ingest it
    let messageId: string | undefined
    let conversationId: string | undefined

    if (params.rawTranscript && params.rawTranscript.segments.length > 0) {
      const transcriptResult = await ingestVoiceTranscript({
        rawTranscript: params.rawTranscript,
        contactId: params.contactId,
        callMetadata: {
          agentId: params.callMetadata.agentId,
          transactionId: params.callMetadata.transactionId,
          listingId: params.callMetadata.listingId,
          initiatorRole: params.callMetadata.initiatorRole,
        },
      })

      if (transcriptResult.success) {
        messageId = transcriptResult.messageId
        conversationId = transcriptResult.conversationId

        // STEP 5: Emit AI ISA handoff signal
        if (conversationId) {
          const summary = `Voice call completed with ${contact.first_name || 'contact'}. Transcript available for review.`
          await emitVoiceHandoffSignal(params.contactId, conversationId, summary, params.callMetadata.agentId ?? "", contact.brokerage_id ?? "")
        }
      } else {
        console.error('[v0] [VOICE ENGINE] Failed to ingest transcript:', transcriptResult.error)
      }
    }

    // STEP 6: Track vendor usage via System 2.4
    const wordCount = params.rawTranscript?.segments.reduce(
      (sum, seg) => sum + seg.text.split(/\s+/).length,
      0
    )

    await trackVoiceCallUsage({
      vendor: params.callMetadata.vendor,
      callDurationSeconds: params.callMetadata.durationSeconds,
      transcriptionWordCount: wordCount,
      contactId: params.contactId,
      agentId: params.callMetadata.agentId,
      brokerageId: contact.brokerage_id,
    })

    // STEP 7: Log completion — Agent task (correct location, no changes) — activity_type: voice_call_processed
    await supabase.from('activities').insert({
      activity_type: 'voice_call_processed',
      title: 'Voice Call Processed',
      description: `${params.callMetadata.callType} call with ${contact.first_name || 'contact'} (${Math.ceil(params.callMetadata.durationSeconds / 60)} min)`,
      status: 'completed',
      priority: 'normal',
      contact_id: params.contactId,
      agent_id: params.callMetadata.agentId,
      transaction_id: params.callMetadata.transactionId,
      duration_minutes: Math.ceil(params.callMetadata.durationSeconds / 60),
      notes: JSON.stringify({
        callStatus,
        vendor: params.callMetadata.vendor,
        transcriptIngested: !!messageId,
      }),
      created_at: new Date().toISOString(),
    })

    return {
      success: true,
      callId,
      messageId,
      conversationId,
    }
  } catch (error: any) {
    console.error('[v0] [VOICE ENGINE] Error processing voice call:', error)

    // Log error
    await supabase.from('automation_errors').insert({
      workflow_name: 'voice_engine_process_call',
      error_message: error.message,
      severity: 'high',
      status: 'unresolved',
      context_json: JSON.stringify({
        contactId: params.contactId,
        callType: params.callMetadata.callType,
        vendor: params.callMetadata.vendor,
      }),
      created_at: new Date().toISOString(),
    })

    return {
      success: false,
      error: error.message,
    }
  }
}
