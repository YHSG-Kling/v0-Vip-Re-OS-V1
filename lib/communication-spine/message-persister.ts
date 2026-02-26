/**
 * SYSTEM 3.1: COMMUNICATION SPINE
 * Message Persistence Layer
 * 
 * THIS IS INFRASTRUCTURE-ONLY. NO UI. NO AI LOGIC.
 * 
 * Purpose: Persist messages to database with idempotency
 * and vendor usage tracking for outbound messages.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { NormalizedMessage } from './message-normalizer'
import { logVendorUsage } from '@/lib/vendor-governance/usage-logger'
import { normalizeVendorCost } from '@/lib/vendor-governance/cost-normalizer'

export interface MessagePersistContext {
  conversationId: string
  contactId: string
  agentId?: string
  transactionId?: string
  listingId?: string
}

export interface MessagePersistResult {
  success: boolean
  messageId?: string
  error?: string
  isDuplicate?: boolean
}

/**
 * PERSIST MESSAGE WITH CONTEXT
 * 
 * Stores a normalized message in the database.
 * 
 * Features:
 * - Idempotent: Detects duplicate messages
 * - Links to conversation, contact, optional transaction/listing
 * - Tracks vendor costs for outbound messages
 * - Updates conversation metadata (message_count, last_message_at)
 */
export async function persistMessageWithContext(
  message: NormalizedMessage,
  context: MessagePersistContext
): Promise<MessagePersistResult> {
  try {
    const supabase = createServiceClient()

    // STEP 1: Check for duplicate (basic idempotency)
    const duplicateCheck = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', context.conversationId)
      .eq('body', message.body)
      .eq('created_at', message.timestamp.toISOString())
      .limit(1)

    if (duplicateCheck.data && duplicateCheck.data.length > 0) {
      console.log('[v0] [COMMUNICATION SPINE] Duplicate message detected, skipping')
      return {
        success: true,
        messageId: duplicateCheck.data[0].id,
        isDuplicate: true,
      }
    }

    // STEP 2: Insert message
    const { data: newMessage, error: insertError } = await supabase
      .from('messages')
      .insert({
        conversation_id: context.conversationId,
        contact_id: context.contactId,
        agent_id: context.agentId,
        type: message.channel,
        direction: message.direction,
        subject: message.subject,
        body: message.body,
        attachment_urls: message.attachmentUrls,
        status: 'sent',
        compliance_checked: false, // Phase 4 will handle compliance
        created_at: message.timestamp.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('[v0] [COMMUNICATION SPINE] Error inserting message:', insertError)
      return {
        success: false,
        error: insertError.message,
      }
    }

    console.log('[v0] [COMMUNICATION SPINE] Message persisted:', newMessage.id)

    // STEP 3: Update conversation metadata
    await supabase.rpc('increment_conversation_message_count', {
      conv_id: context.conversationId,
    }).catch((err) => {
      // Non-critical, just log
      console.warn('[v0] [COMMUNICATION SPINE] Failed to update conversation count:', err)
    })

    await supabase
      .from('conversations')
      .update({
        last_message_at: message.timestamp.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', context.conversationId)

    // STEP 4: Track vendor usage if outbound
    if (message.direction === 'outbound') {
      await trackOutboundVendorCost(message, context)
    }

    return {
      success: true,
      messageId: newMessage.id,
      isDuplicate: false,
    }
  } catch (error: any) {
    console.error('[v0] [COMMUNICATION SPINE] Unexpected error persisting message:', error)
    
    // Log to automation_errors
    const supabase = createServiceClient()
    await supabase.from('automation_errors').insert({
      workflow_name: 'communication_spine_persist_message',
      error_message: error.message,
      severity: 'high',
      status: 'unresolved',
      context_json: JSON.stringify({
        conversationId: context.conversationId,
        contactId: context.contactId,
        channel: message.channel,
        timestamp: message.timestamp.toISOString(),
      }),
      created_at: new Date().toISOString(),
    })

    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * Helper: Track vendor costs for outbound messages
 */
async function trackOutboundVendorCost(
  message: NormalizedMessage,
  context: MessagePersistContext
): Promise<void> {
  try {
    let vendor = ''
    let unitCount = 1

    if (message.channel === 'email') {
      vendor = 'sendgrid_email' // Or whatever email provider
      unitCount = 1
    } else if (message.channel === 'sms') {
      vendor = 'twilio_sms'
      unitCount = 1
    }

    if (vendor) {
      const estimatedCost = normalizeVendorCost(vendor, unitCount)
      await logVendorUsage({
        vendorName: vendor,
        usageType: 'api_calls',
        unitCount,
        estimatedCost,
        systemSource: 'communication_spine',
        agentId: context.agentId,
        metadata: {
          messageChannel: message.channel,
          messageLength: message.body.length,
          contactId: context.contactId,
          transactionId: context.transactionId,
        },
        timestamp: new Date(),
      })
    }
  } catch (error) {
    console.warn('[v0] [COMMUNICATION SPINE] Failed to track vendor cost:', error)
    // Non-critical, don't fail the message send
  }
}
