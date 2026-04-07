/**
 * SYSTEM 3.1: COMMUNICATION SPINE
 * Message Persistence Layer
 * 
 * THIS IS INFRASTRUCTURE-ONLY. NO UI. NO AI LOGIC.
 * 
 * Purpose: Persist messages to client_portal_messages (canonical portal table) with idempotency
 * and vendor usage tracking for outbound messages.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { NormalizedMessage } from './message-normalizer'
import { logVendorUsage, normalizeVendorCost } from '@/lib/vendor-governance'

export interface MessagePersistContext {
  conversationId: string
  contactId: string
  agentId?: string
  brokerageId: string
  transactionId?: string
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
 * Stores a normalized message to client_portal_messages (canonical schema).
 * Per Kernel OS contract:
 * - client_portal_messages table stores all portal communication
 * - direction: 'agent_to_client' or 'client_to_agent' (never inbound/outbound)
 * - brokerage_id is required ownership key
 * 
 * Features:
 * - Idempotent: Detects duplicate messages
 * - Links to contact, agent, transaction, brokerage
 * - Tracks vendor costs for outbound messages
 */
export async function persistMessageWithContext(
  message: NormalizedMessage,
  context: MessagePersistContext
): Promise<MessagePersistResult> {
  try {
    const supabase = createServiceClient()

    // STEP 1: Check for duplicate (basic idempotency)
    const duplicateCheck = await supabase
      .from('client_portal_messages')
      .select('id')
      .eq('contact_id', context.contactId)
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

    // STEP 2: Map direction semantics (normalize channel to direction)
    // message.direction may be 'outbound'/'inbound' from normalizer, must map to 'agent_to_client'/'client_to_agent'
    let direction: 'agent_to_client' | 'client_to_agent'
    if (message.direction === 'outbound' || message.direction === 'agent_to_client') {
      direction = 'agent_to_client'
    } else {
      direction = 'client_to_agent'
    }

    // STEP 3: Insert message to canonical client_portal_messages table
    const { data: newMessage, error: insertError } = await supabase
      .from('client_portal_messages')
      .insert({
        contact_id: context.contactId,
        agent_id: context.agentId || null,
        brokerage_id: context.brokerageId,
        body: message.body,
        direction,
        channel: message.channel,
        read: false,
        read_at: null,
        transaction_id: context.transactionId || null,
        created_at: message.timestamp.toISOString(),
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

    console.log('[v0] [COMMUNICATION SPINE] Message persisted to client_portal_messages:', newMessage.id)

    // STEP 4: Track vendor usage if outbound
    if (direction === 'agent_to_client') {
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
        contactId: context.contactId,
        brokerageId: context.brokerageId,
        channel: message.channel,
        direction: message.direction,
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
        brokerageId: context.brokerageId,
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
