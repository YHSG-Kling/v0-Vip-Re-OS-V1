/**
 * lib/communication-spine/ingest-message-service.ts
 * Canonical lib-layer implementation of message ingestion.
 * app/actions/communication-spine/ingest-message.ts re-exports from here.
 */

import { getOrCreateConversation } from './conversation-manager'
import { validateMessageInitiationRules, AuthorType } from './role-validator'
import {
  normalizeInboundMessage,
  normalizeOutboundMessage,
  RawInboundMessage,
  MessageChannel,
} from './message-normalizer'
import { persistMessageWithContext } from './message-persister'
import { createServiceClient } from '@/lib/supabase/service'

export interface IngestMessageParams {
  contactId: string
  transactionId?: string
  listingId?: string
  agentId?: string
  rawMessage?: RawInboundMessage
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

export async function ingestMessageService(
  params: IngestMessageParams
): Promise<IngestMessageResult> {
  try {
    const supabase = createServiceClient()

    // STEP 1: Validate contact exists
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, brokerage_id')
      .eq('id', params.contactId)
      .single()

    if (contactError || !contact) {
      return { success: false, error: 'Contact not found' }
    }

    // STEP 2: Get or create conversation
    const convResult = await getOrCreateConversation({
      contactId: params.contactId,
      transactionId: params.transactionId,
      listingId: params.listingId,
      agentId: params.agentId,
      initialChannel: (params.rawMessage?.channel || params.outboundMessage?.channel) as "email" | "sms" | "social_dm" | "voice" | undefined,
    })

    if (!convResult.success || !convResult.conversationId) {
      return {
        success: false,
        error: `Failed to get/create conversation: ${convResult.error}`,
      }
    }

    // STEP 3: Determine direction and normalize
    let normalizedMessage
    let authorType: AuthorType

    if (params.rawMessage) {
      normalizedMessage = normalizeInboundMessage(params.rawMessage, params.contactId)
      authorType = 'contact'
    } else if (params.outboundMessage && params.authorType) {
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
      return { success: false, error: validation.reason }
    }

    // STEP 5: Persist message
    const persistResult = await persistMessageWithContext(normalizedMessage, {
      conversationId: convResult.conversationId,
      contactId: params.contactId,
      brokerageId: contact.brokerage_id,
      agentId: params.agentId,
      transactionId: params.transactionId,
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
    console.error('[communication-spine] Unexpected error in ingestMessageService:', error)
    return { success: false, error: error.message }
  }
}
