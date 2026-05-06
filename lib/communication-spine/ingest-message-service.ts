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

    // STEP 3b: TCPA/DNC opt-out detection on inbound contact messages.
    // If the contact sends an opt-out phrase, immediately suppress all outreach
    // and notify the agent. Message is still persisted for the audit trail.
    if (params.rawMessage && authorType === 'contact') {
      const body = (params.rawMessage.body ?? '').trim().toLowerCase()
      const channel = params.rawMessage.channel

      // Per TCPA: any inbound SMS with just "STOP" (or common variants) is a
      // hard opt-out — no follow-up permitted on that channel.
      const smsOptOut = (channel === 'sms') &&
        /^\s*(stop|unsubscribe|cancel|end|quit|remove)\s*$/i.test(body)

      // Global DNC phrases — any channel.
      const globalOptOut =
        /\b(do not contact|do not call|remove me|dnc|stop all|unsubscribe all)\b/i.test(body)

      if (smsOptOut || globalOptOut) {
        const optOutChannel = globalOptOut ? 'all' : (channel === 'email' ? 'email' : 'sms')
        const source = channel === 'sms' ? 'inbound_sms' : 'inbound_email'

        // Fire-and-forget: update contact suppression flags
        supabase
          .from('contacts')
          .update({
            ...(globalOptOut ? {
              dnc_status: true,
              email_opt_out: true,
              sms_opt_out: true,
              phone_opt_out: true,
              direct_mail_opt_out: true,
              isa_reengage_allowed: false,
            } : channel === 'sms' ? { sms_opt_out: true } : { email_opt_out: true }),
            opted_out_at: new Date().toISOString(),
            opt_out_reason: params.rawMessage.body?.slice(0, 500) ?? `Opt-out via ${source}`,
            opt_out_source: source,
            updated_at: new Date().toISOString(),
          })
          .eq('id', params.contactId)
          .then(({ error }) => {
            if (error) console.error('[communication-spine] DNC update failed:', error)
          })
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
