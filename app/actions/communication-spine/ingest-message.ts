'use server'

/**
 * SYSTEM 3.1: UNIFIED COMMUNICATION SPINE
 * Main Message Ingestion Orchestrator
 * 
 * THIS IS INFRASTRUCTURE-ONLY. NO UI. NO AI LOGIC.
 * 
 * This is the PUBLIC API for all message ingestion.
 * All inbound and outbound messages must flow through this action.
 * 
 * Phase 3 AI systems will call this AFTER generating content.
 * Phase 4 Compliance will read from the messages table.
 * 
 * USAGE EXAMPLES:
 * 
 * ```typescript
 * // Inbound email from contact
 * await ingestMessage({
 *   contactId: 'uuid',
 *   rawMessage: {
 *     channel: 'email',
 *     from: 'contact@example.com',
 *     to: 'agent@brokerage.com',
 *     subject: 'Question about property',
 *     body: 'I have a question...',
 *   }
 * })
 * 
 * // Outbound email from AI ISA
 * await ingestMessage({
 *   contactId: 'uuid',
 *   authorType: 'ai',
 *   agentId: 'uuid',
 *   outboundMessage: {
 *     channel: 'email',
 *     subject: 'Follow up on your inquiry',
 *     body: 'Thank you for reaching out...',
 *   }
 * })
 * ```
 */

import { getOrCreateConversation } from '@/lib/communication-spine/conversation-manager'
import { validateMessageInitiationRules, AuthorType } from '@/lib/communication-spine/role-validator'
import { 
  normalizeInboundMessage, 
  normalizeOutboundMessage, 
  RawInboundMessage,
  MessageChannel
} from '@/lib/communication-spine/message-normalizer'
import { persistMessageWithContext } from '@/lib/communication-spine/message-persister'
import { createServiceClient } from '@/lib/supabase/service'

export interface IngestMessageParams {
  contactId: string
  transactionId?: string
  listingId?: string
  agentId?: string
  
  // For INBOUND messages
  rawMessage?: RawInboundMessage
  
  // For OUTBOUND messages
  authorType?: AuthorType
  outboundMessage?: {
    channel: MessageChannel
    subject?: string
    body: string
    attachments?: string[]
    metadata?: Record<string, any>
  }
}

export interface IngestMessageResult {
  success: boolean
  conversationId?: string
  messageId?: string
  error?: string
  warning?: string
}

/**
 * INGEST MESSAGE (PUBLIC API)
 * 
 * This is the ONLY way systems should persist messages.
 * Provides:
 * - Conversation management
 * - Role-based validation
 * - Message normalization
 * - Idempotent storage
 * - Vendor cost tracking
 */
export async function ingestMessage(params: IngestMessageParams): Promise<IngestMessageResult> {
  try {
    // STEP 1: Validate contact exists
    const supabase = createServiceClient()
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, brokerage_id')
      .eq('id', params.contactId)
      .single()

    if (contactError || !contact) {
      return {
        success: false,
        error: 'Contact not found',
      }
    }

    // STEP 2: Get or create conversation
    const convResult = await getOrCreateConversation({
      contactId: params.contactId,
      transactionId: params.transactionId,
      listingId: params.listingId,
      agentId: params.agentId,
      initialChannel: params.rawMessage?.channel || params.outboundMessage?.channel,
    })

    if (!convResult.success || !convResult.conversationId) {
      return {
        success: false,
        error: `Failed to get/create conversation: ${convResult.error}`,
      }
    }

    // STEP 3: Determine message direction and normalize
    let normalizedMessage
    let authorType: AuthorType

    if (params.rawMessage) {
      // INBOUND from contact
      normalizedMessage = normalizeInboundMessage(params.rawMessage, params.contactId)
      authorType = 'contact'
    } else if (params.outboundMessage && params.authorType) {
      // OUTBOUND from system
      normalizedMessage = normalizeOutboundMessage(
        params.outboundMessage.channel,
        params.authorType,
        params.outboundMessage.body,
        {
          subject: params.outboundMessage.subject,
          attachments: params.outboundMessage.attachments,
          metadata: params.outboundMessage.metadata,
        }
      )
      authorType = params.authorType
    } else {
      return {
        success: false,
        error: 'Must provide either rawMessage (inbound) or outboundMessage with authorType',
      }
    }

    // STEP 4: Validate role-based messaging rules
    const validation = validateMessageInitiationRules({
      authorType,
      action: convResult.isNew ? 'initiate' : 'respond',
      contactId: params.contactId,
      conversationId: convResult.conversationId,
      agentId: params.agentId,
      isThreadResponse: !convResult.isNew,
    })

    if (!validation.allowed) {
      // Log violation
      if (validation.shouldLog) {
        await supabase.from('automation_errors').insert({
          workflow_name: 'communication_spine_role_violation',
          error_message: validation.reason || 'Role-based messaging rule violated',
          severity: 'medium',
          status: 'unresolved',
          context_json: JSON.stringify({
            authorType,
            contactId: params.contactId,
            conversationId: convResult.conversationId,
          }),
          created_at: new Date().toISOString(),
        })
      }

      return {
        success: false,
        error: validation.reason,
      }
    }

    // STEP 5: Persist message
    const persistResult = await persistMessageWithContext(normalizedMessage, {
      conversationId: convResult.conversationId,
      contactId: params.contactId,
      agentId: params.agentId,
      transactionId: params.transactionId,
      listingId: params.listingId,
    })

    if (!persistResult.success) {
      return {
        success: false,
        error: `Failed to persist message: ${persistResult.error}`,
      }
    }

    return {
      success: true,
      conversationId: convResult.conversationId,
      messageId: persistResult.messageId,
      warning: persistResult.isDuplicate ? 'Duplicate message detected' : undefined,
    }
  } catch (error: any) {
    console.error('[v0] [COMMUNICATION SPINE] Unexpected error in ingestMessage:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}
