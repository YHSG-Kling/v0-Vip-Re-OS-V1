'use server'

/**
 * SYSTEM 3.2: AI ISA CONTACT ENGAGEMENT
 * Main Orchestrator
 * 
 * This is the AI-FIRST contact engagement system.
 * It responds to contact messages, qualifies intent, and signals readiness.
 * 
 * KEY PRINCIPLES:
 * - Always identifies as an AI assistant
 * - Focuses on education and value, not pressure
 * - Gathers qualification signals incrementally
 * - Escalates when ready but does NOT notify agents directly
 * - Writes ALL messages through System 3.1 (Communication Spine)
 * - Tracks vendor usage via System 2.4
 * 
 * USAGE:
 * ```typescript
 * await respondToContact({
 *   contactId: 'uuid',
 *   inboundMessageId: 'uuid',
 *   messageContent: 'I have a question about...'
 * })
 * ```
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  generateAIResponse,
  extractQualificationSignals,
  persistQualificationSignals,
  evaluateHandoffReadiness,
  logHandoffSignal,
  type ResponseContext,
} from '@/lib/ai-isa-contact'
import { ingestMessageService as ingestMessage } from '@/lib/communication-spine'
import { trackVendorUsageService as trackVendorUsage } from '@/lib/vendor-governance'

export interface RespondToContactParams {
  contactId: string
  inboundMessageId: string
  messageContent: string
  conversationId?: string
}

export interface RespondToContactResult {
  success: boolean
  responseMessageId?: string
  escalationSignaled?: boolean
  error?: string
}

/**
 * RESPOND TO CONTACT (Main Orchestrator)
 */
export async function respondToContact(
  params: RespondToContactParams
): Promise<RespondToContactResult> {
  const supabase = createServiceClient()

  try {
    console.log(`[v0] [AI ISA CONTACT] Processing contact ${params.contactId}`)

    // STEP 1: Fetch contact details
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, first_name, brokerage_id, agent_id, contact_persona, intent_score')
      .eq('id', params.contactId)
      .single()

    if (contactError || !contact) {
      return {
        success: false,
        error: 'Contact not found',
      }
    }

    // STEP 2: Fetch conversation history
    const { data: messages } = await supabase
      .from('messages')
      .select('body, direction, created_at')
      .eq('contact_id', params.contactId)
      .order('created_at', { ascending: false })
      .limit(10)

    const conversationHistory = (messages || []).map(msg => ({
      role: msg.direction === 'inbound' ? 'contact' as const : 'ai' as const,
      content: msg.body || '',
      timestamp: new Date(msg.created_at),
    }))

    // STEP 3: Extract qualification signals
    const signals = await extractQualificationSignals({
      contactId: params.contactId,
      messageContent: params.messageContent,
      conversationHistory: conversationHistory.map(m => m.content),
    })

    await persistQualificationSignals(params.contactId, signals)

    // STEP 4: Generate AI response
    const responseContext: ResponseContext = {
      contactId: params.contactId,
      conversationHistory,
      contactPersona: contact.contact_persona,
      intent: signals.buyerSeller !== 'unknown' ? signals.buyerSeller : undefined,
      timeline: signals.urgency !== 'unknown' ? signals.urgency : undefined,
    }

    const aiResponse = await generateAIResponse(responseContext)

    // STEP 5: Track vendor usage (AI model cost)
    await trackVendorUsage({
      vendor: 'openai_gpt4',
      unitCount: 500, // Estimated tokens
      systemSource: 'ai_isa_contact',
      brokerageId: contact.brokerage_id,
      contactId: params.contactId,
      agentId: contact.agent_id,
      metadata: {
        messageType: 'contact_response',
        confidenceScore: aiResponse.confidenceScore,
      },
    })

    // STEP 6: Write response via Communication Spine
    const messageResult = await ingestMessage({
      contactId: params.contactId,
      authorType: 'ai',
      agentId: contact.agent_id,
      outboundMessage: {
        channel: 'email',
        subject: 'Re: Your inquiry',
        body: aiResponse.messageBody,
        metadata: {
          generatedBy: 'ai_isa_contact',
          confidenceScore: aiResponse.confidenceScore,
        },
      },
    })

    if (!messageResult.success) {
      return {
        success: false,
        error: `Failed to send response: ${messageResult.error}`,
      }
    }

    // STEP 7: Evaluate handoff readiness
    const handoffSignal = await evaluateHandoffReadiness({
      contactId: params.contactId,
      conversationMessages: conversationHistory.length + 1,
      qualificationScore: signals.readinessScore,
      explicitAgentRequest: aiResponse.escalationSignal || false,
    })

    let escalationLogged = false
    if (handoffSignal.shouldEscalate) {
      escalationLogged = await logHandoffSignal(params.contactId, handoffSignal)
      console.log(`[AI ISA Contact] Handoff signal logged for ${params.contactId}`)
    }

    // STEP 8: Log completion — Agent task (correct location, no changes) — activity_type: ai_isa_response
    await supabase.from('activities').insert({
      activity_type: 'ai_isa_response',
      title: 'AI ISA Contact Response',
      description: `AI responded to ${contact.first_name || 'contact'}`,
      status: 'completed',
      priority: 'normal',
      contact_id: params.contactId,
      agent_id: contact.agent_id,
      notes: JSON.stringify({
        qualificationScore: signals.readinessScore,
        escalationSignaled: handoffSignal.shouldEscalate,
      }),
      created_at: new Date().toISOString(),
    })

    return {
      success: true,
      responseMessageId: messageResult.messageId,
      escalationSignaled: escalationLogged,
    }
  } catch (error: any) {
    console.error('[v0] [AI ISA CONTACT] Error responding to contact:', error)

    // Log error
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_contact_response',
      error_message: error.message,
      severity: 'high',
      status: 'unresolved',
      context_json: JSON.stringify({
        contactId: params.contactId,
        inboundMessageId: params.inboundMessageId,
      }),
      created_at: new Date().toISOString(),
    })

    return {
      success: false,
      error: error.message,
    }
  }
}
