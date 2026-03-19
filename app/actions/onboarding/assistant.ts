'use server'

import { createClient } from '@/lib/supabase/server'
import { transitionLifecycle } from '@/lib/kernel/lifecycle'
import { KernelEvent } from '@/lib/kernel/events'
import { getAgentContext } from '@/lib/identity/get-agent-context'

export async function getHelpTopics(category?: string) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  let query = supabase
    .from('help_topics_kb')
    .select('*')
    .eq('is_active', true)
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .order('title')

  if (category) {
    query = query.eq('category', category)
  }

  const { data, error } = await query

  if (error) {
    console.log('[v0] Error fetching help topics:', error.message)
    throw new Error('Failed to fetch help topics')
  }

  return data || []
}

export async function searchHelpTopics(query: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Simple full-text search
  const { data, error } = await supabase
    .from('help_topics_kb')
    .select('*')
    .eq('is_active', true)
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .or(
      `title.ilike.%${query}%,content.ilike.%${query}%`
    )
    .limit(10)

  if (error) {
    console.log('[v0] Error searching help topics:', error.message)
    return []
  }

  return data || []
}

export async function saveAssistantChat(
  agentOnboardingId: string,
  messages: any[],
  currentStep: string,
  escalated: boolean = false
) {
  const supabase = await createClient()
  const { agentId } = await getAgentContext()

  const { data: existingChat } = await supabase
    .from('onboarding_ai_chats')
    .select('id')
    .eq('agent_onboarding_id', agentOnboardingId)
    .single()

  if (existingChat) {
    // Update existing chat
    const { error } = await supabase
      .from('onboarding_ai_chats')
      .update({
        messages,
        current_step: currentStep,
        escalated,
        escalated_at: escalated ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingChat.id)

    if (error) {
      console.log('[v0] Error updating assistant chat:', error.message)
      throw new Error('Failed to save chat')
    }
  } else {
    // Create new chat
    const { error } = await supabase
      .from('onboarding_ai_chats')
      .insert({
        agent_id: agentId,
        agent_onboarding_id: agentOnboardingId,
        messages,
        current_step: currentStep,
        escalated,
        escalated_at: escalated ? new Date().toISOString() : null,
      })

    if (error) {
      console.log('[v0] Error creating assistant chat:', error.message)
      throw new Error('Failed to save chat')
    }
  }
}

export async function getAssistantChat(agentOnboardingId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('onboarding_ai_chats')
    .select('*')
    .eq('agent_onboarding_id', agentOnboardingId)
    .single()

  if (error && error.code !== 'PGRST116') {
    console.log('[v0] Error fetching assistant chat:', error.message)
    throw new Error('Failed to fetch chat')
  }

  return data || null
}

export async function fireAssistantEvent(
  agentId: string,
  event: 'query_made' | 'escalated',
  currentStep: string
) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const eventMap = {
    query_made: KernelEvent.SETUP_ASSISTANT_QUERY_MADE,
    escalated: KernelEvent.SETUP_ASSISTANT_ESCALATED,
  }

  try {
    await supabase
      .from('lifecycle_events')
      .insert({
        event_type: eventMap[event],
        entity_type: 'agent',
        entity_id: agentId,
        brokerage_id: brokerageId,
        actor_user_id: agentId,
        metadata: {
          step: currentStep,
          timestamp: new Date().toISOString(),
        },
      })
  } catch (error) {
    console.log('[v0] Error firing assistant event:', error)
    // Don't throw - event logging shouldn't break the flow
  }
}

export async function escapeAssistant(
  agentOnboardingId: string,
  reason: string,
  currentStep: string
) {
  const supabase = await createClient()
  const { agentId } = await getAgentContext()

  // Mark as escalated
  await saveAssistantChat(agentOnboardingId, [], currentStep, true)

  // Fire escalation event
  await fireAssistantEvent(agentId, 'escalated', currentStep)

  // Create escalation ticket
  const { error } = await supabase
    .from('support_tickets')
    .insert({
      agent_id: agentId,
      subject: `Onboarding Support: ${currentStep}`,
      description: reason,
      priority: 'high',
      category: 'onboarding',
      status: 'open',
    })
    .select('id')
    .single()

  if (error) {
    console.log('[v0] Error creating support ticket:', error.message)
    throw new Error('Failed to escalate to support')
  }

  return { escalated: true }
}
