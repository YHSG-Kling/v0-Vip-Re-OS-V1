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
import { KernelEvent } from '@/lib/kernel/events'

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
    // Set when the STEP 3b suppression write is REFUSED — read at the final
    // return so this never reports success on a lost opt-out.
    let suppressionError: string | null = null

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

        // AWAITED, NOT FIRE-AND-FORGET. This is the consumer's STOP. It used to
        // be launched un-awaited with a `.then` that console.error'd the failure
        // and nothing else — so the function ran on and returned `{ success:
        // true }` for an opt-out the row never took, which is a fail-open on
        // suppression (CLAUDE.md §4). The message is STILL persisted below
        // either way (the audit trail must survive a refused suppression); what
        // changes is that the caller stops being told this succeeded.
        const { error: suppressWriteError } = await supabase
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
        if (suppressWriteError) {
          suppressionError = suppressWriteError.message
          console.error('[communication-spine] DNC update REFUSED:', suppressWriteError.message)
        }
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
      // TENANT — `contact.brokerage_id`, from the contact this message is filed
      // against, already read and error-checked at STEP 1 above. Resolved once,
      // not re-fetched here. Unstamped, a role violation is invisible in the
      // automations console AND un-resolvable through it (`workflows.ts:531`
      // treats the same predicate as an ownership check and returns "Forbidden"
      // on a miss), so a messaging-rule breach would be recorded where the
      // brokerage that must act on it can never reach it.
      if (validation.shouldLog) {
        if (!contact.brokerage_id) {
          console.error(
            `[communication-spine] role violation for contact ${params.contactId}: contact carries no brokerage_id — automation_errors row NOT written rather than written where the console can neither see nor resolve it`,
          )
        } else {
          const { error: roleViolationLogError } = await supabase.from('automation_errors').insert({
            brokerage_id: contact.brokerage_id,
            workflow_name: 'communication_spine_role_violation',
            error_message: validation.reason || 'Role-based messaging rule violated',
            severity: 'medium',
            status: 'open',
            context_json: JSON.stringify({
              authorType,
              contactId: params.contactId,
              conversationId: convResult.conversationId,
            }),
            created_at: new Date().toISOString(),
          })
          if (roleViolationLogError) {
            console.error('[communication-spine] automation_errors insert refused:', roleViolationLogError.message)
          }
        }
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

    // Pause-on-reply: when a contact (authorType='contact') sends an
    // inbound message, the agent has the conversation now — the kernel
    // shouldn't keep firing automated sequence steps over the top of a
    // live human exchange. Pause every active enrollment for this
    // contact; the agent re-activates manually when ready.
    if (authorType === 'contact' && params.contactId && !persistResult.isDuplicate) {
      void pauseActiveSequenceEnrollmentsOnReply(params.contactId).catch((e) => {
        console.error('[communication-spine] pause-on-reply failed:', e)
      })
    }

    // FAIL CLOSED (CLAUDE.md §4). The message landed — that is why messageId and
    // conversationId still come back — but if the contact's opt-out flags were
    // REFUSED at STEP 3b, outreach is not actually suppressed and no caller may
    // read this as a clean success.
    if (suppressionError) {
      return {
        success: false,
        conversationId: convResult.conversationId,
        messageId: persistResult.messageId,
        error: `Message stored, but the contact's opt-out was NOT applied: ${suppressionError}`,
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

/**
 * Pause every active sequence_enrollments row for this contact when they
 * reply. The kernel's job is to amplify the agent — once the contact is in
 * a live conversation, automated steps over the top would fight the agent.
 *
 * Pauses (status='paused') rather than cancels — agent can re-activate
 * the enrollment from the contact detail when ready, e.g. after the
 * conversation winds down.
 *
 * Inserts a lifecycle_event so the contact's activity feed shows why the
 * sequences paused (the agent can see "Sequence paused — contact replied").
 */
async function pauseActiveSequenceEnrollmentsOnReply(contactId: string): Promise<void> {
  const supabase = createServiceClient()

  const { data: active } = await supabase
    .from('sequence_enrollments')
    .select('id, sequence_id, brokerage_id')
    .eq('contact_id', contactId)
    .eq('status', 'active')

  if (!active || active.length === 0) return

  const ids = active.map(e => e.id)
  await supabase
    .from('sequence_enrollments')
    .update({
      status:        'paused',
      next_step_at:  null,  // step worker will skip until manually resumed
    })
    .in('id', ids)

  // One kernel event per paused enrollment — audit row + reactor. suppressEnrollment:
  // this IS the sequence engine reacting to a reply; its own event must not re-enroll.
  const { emitKernelEvent } = await import('@/lib/kernel/emit')
  for (const e of active) {
    await emitKernelEvent({
      brokerageId:  e.brokerage_id,
      entityType:   'sequence_enrollment',
      entityId:     e.id,
      event:        KernelEvent.SEQUENCE_PAUSED_ON_REPLY,
      contactId,
      metadata:     { reason: 'contact_replied', sequence_id: e.sequence_id },
      suppressEnrollment: true,
    }).then(() => null, () => null)
  }
}
