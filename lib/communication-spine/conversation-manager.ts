/**
 * SYSTEM 3.1: COMMUNICATION SPINE
 * Conversation Manager
 * 
 * THIS IS INFRASTRUCTURE-ONLY. NO UI. NO AI LOGIC.
 * 
 * Purpose: Manage contact-scoped conversations as the authority
 * for all message persistence. Conversations may optionally link to
 * transactions and listings, but exist independently.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface ConversationContext {
  contactId: string
  transactionId?: string
  listingId?: string
  initialChannel?: 'email' | 'sms' | 'voice' | 'social_dm'
  agentId?: string
}

export interface ConversationResult {
  success: boolean
  conversationId?: string
  error?: string
  isNew?: boolean
}

/**
 * GET OR CREATE CONVERSATION
 * 
 * Conversations are contact-scoped. A contact can have multiple
 * conversations (e.g., one per transaction), but each conversation
 * must have a contact.
 * 
 * This function is idempotent - safe to call multiple times.
 */
export async function getOrCreateConversation(
  context: ConversationContext
): Promise<ConversationResult> {
  try {
    const supabase = createServiceClient()

    // Validate required fields
    if (!context.contactId) {
      return {
        success: false,
        error: 'contactId is required',
      }
    }

    // Build query to find existing conversation
    let query = supabase
      .from('conversations')
      .select('id, status, type, contact_id, agent_id')
      .eq('contact_id', context.contactId)

    // Optionally match on transaction/listing if provided
    if (context.transactionId) {
      // Note: Need to add transaction_id to conversations table if linking
      // For now, conversations are just contact-scoped
    }

    if (context.listingId) {
      // Note: Same for listing_id
    }

    query = query.eq('status', 'active').order('created_at', { ascending: false }).limit(1)

    const { data: existing, error: fetchError } = await query

    if (fetchError) {
      console.error('[v0] [COMMUNICATION SPINE] Error fetching conversation:', fetchError)
      return {
        success: false,
        error: fetchError.message,
      }
    }

    // If conversation exists, return it
    if (existing && existing.length > 0) {
      return {
        success: true,
        conversationId: existing[0].id,
        isNew: false,
      }
    }

    // Create new conversation
    const { data: newConv, error: createError } = await supabase
      .from('conversations')
      .insert({
        contact_id: context.contactId,
        agent_id: context.agentId,
        type: context.initialChannel || 'email',
        status: 'active',
        message_count: 0,
        unread_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (createError) {
      console.error('[v0] [COMMUNICATION SPINE] Error creating conversation:', createError)
      return {
        success: false,
        error: createError.message,
      }
    }

    console.log('[v0] [COMMUNICATION SPINE] Created conversation:', newConv.id)

    return {
      success: true,
      conversationId: newConv.id,
      isNew: true,
    }
  } catch (error: any) {
    console.error('[v0] [COMMUNICATION SPINE] Unexpected error:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}
