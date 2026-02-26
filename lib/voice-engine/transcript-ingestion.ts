/**
 * VOICE ENGINE: TRANSCRIPT INGESTION
 * 
 * Writes voice transcripts into System 3.1 as messages.
 * 
 * KEY PRINCIPLE: Voice is just another channel.
 * The Communication Spine handles persistence.
 * We just normalize and pass through.
 */

import { getOrCreateConversation } from '@/lib/communication-spine/conversation-manager'
import { normalizeOutboundMessage } from '@/lib/communication-spine/message-normalizer'
import { persistMessageWithContext } from '@/lib/communication-spine/message-persister'
import { normalizeVoiceTranscript, NormalizedTranscript, RawTranscript } from './transcript-normalizer'

export interface IngestTranscriptParams {
  rawTranscript: RawTranscript
  contactId: string
  callMetadata: {
    agentId?: string
    transactionId?: string
    listingId?: string
    initiatorRole: 'ai' | 'agent' | 'contact' | 'office'
  }
}

export interface IngestTranscriptResult {
  success: boolean
  messageId?: string
  conversationId?: string
  error?: string
}

/**
 * INGEST VOICE TRANSCRIPT
 * 
 * Converts voice transcript into message and writes via System 3.1.
 * This ensures all voice interactions are part of the auditable communication record.
 */
export async function ingestVoiceTranscript(
  params: IngestTranscriptParams
): Promise<IngestTranscriptResult> {
  try {
    console.log('[v0] [VOICE ENGINE] Ingesting transcript for call:', params.rawTranscript.callId)

    // STEP 1: Normalize transcript
    const normalized = normalizeVoiceTranscript(params.rawTranscript)

    // STEP 2: Determine author type based on who initiated the call
    const authorType = params.callMetadata.initiatorRole

    // STEP 3: Write transcript as message via Communication Spine
    // 3a. Get or create conversation for this contact
    const conversation = await getOrCreateConversation({
      contactId: params.contactId,
      transactionId: params.callMetadata.transactionId,
      listingId: params.callMetadata.listingId,
      agentId: params.callMetadata.agentId,
      initialChannel: 'voice',
    })

    if (!conversation.success || !conversation.conversationId) {
      return { success: false, error: conversation.error ?? 'Could not resolve conversation' }
    }

    // 3b. Normalize the transcript into the standard message format
    const normalizedMsg = normalizeOutboundMessage(
      'voice_transcript',
      authorType,
      normalized.fullText,
      {
        subject: `Voice Call Transcript (${Math.ceil(normalized.metadata.duration / 60)} min)`,
        metadata: {
          callId: params.rawTranscript.callId,
          vendor: normalized.metadata.vendor,
          durationSeconds: normalized.metadata.duration,
          wasComplete: normalized.metadata.wasComplete,
          speakers: normalized.speakers.map(s => s.role),
          transcriptQuality: normalized.metadata.wasComplete ? 'complete' : 'partial',
        },
      }
    )

    // 3c. Persist via Communication Spine
    const result = await persistMessageWithContext(normalizedMsg, {
      conversationId: conversation.conversationId,
      contactId: params.contactId,
      agentId: params.callMetadata.agentId,
      transactionId: params.callMetadata.transactionId,
      listingId: params.callMetadata.listingId,
    })

    if (!result.success) {
      console.error('[v0] [VOICE ENGINE] Failed to ingest transcript:', result.error)
      return {
        success: false,
        error: result.error,
      }
    }

    console.log(`[v0] [VOICE ENGINE] Transcript ingested as message ${result.messageId}`)

    return {
      success: true,
      messageId: result.messageId,
      conversationId: conversation.conversationId,
    }
  } catch (error: any) {
    console.error('[v0] [VOICE ENGINE] Error ingesting transcript:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * EMIT AI ISA HANDOFF SIGNAL
 * 
 * After transcript ingestion, signals AI ISA that new voice input is available.
 * AI ISA may choose to respond via text channels based on voice content.
 * 
 * NOTE: This system does NOT call AI ISA directly.
 * It only logs an activity that upstream systems can observe.
 */
export async function emitVoiceHandoffSignal(
  contactId: string,
  conversationId: string,
  transcriptSummary: string,
  agentId: string,
  brokerageId: string
): Promise<boolean> {
  try {
    const supabase = await import('@/lib/supabase/service').then(m => m.createServiceClient())

    await supabase.from('activities').insert({
      activity_type: 'voice_transcript_available',
      title: 'Voice Transcript Available for AI Review',
      description: transcriptSummary,
      status: 'pending',
      priority: 'normal',
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      notes: JSON.stringify({
        conversationId,
        signal: 'ai_isa_review_requested',
      }),
      created_at: new Date().toISOString(),
    })

    console.log(`[v0] [VOICE ENGINE] AI ISA handoff signal emitted for contact ${contactId}`)
    return true
  } catch (error) {
    console.error('[v0] [VOICE ENGINE] Failed to emit handoff signal:', error)
    return false
  }
}
