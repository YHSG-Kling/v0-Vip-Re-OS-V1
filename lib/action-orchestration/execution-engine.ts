/**
 * System 3.5 - Follow-Up Execution Engine
 * 
 * Executes action plans by calling System 3.1 (Communication Spine).
 * Logs all executions to activities table.
 */

import { createClient } from '@/lib/supabase/server'
import type { ActionPlan } from './orchestrator'

export interface ExecutionResult {
  success: boolean
  action_plan: ActionPlan
  executed_at: string
  execution_id?: string
  error?: string
  response?: any
}

/**
 * Execute a single action plan
 */
export async function executeAction(
  action: ActionPlan,
  contact: any,
  agent?: any
): Promise<ExecutionResult> {
  const supabase = await createClient()
  const executedAt = new Date().toISOString()
  
  try {
    let executionResponse: any
    
    switch (action.action_type) {
      case 'SEND_MESSAGE':
        executionResponse = await executeSendMessage(action, contact)
        break
        
      case 'SEND_EMAIL':
        executionResponse = await executeSendEmail(action, contact)
        break
        
      case 'SEND_SMS':
        executionResponse = await executeSendSMS(action, contact)
        break
        
      case 'INITIATE_CALL':
        executionResponse = await executeInitiateCall(action, contact, agent)
        break
        
      case 'ASSIGN_AGENT':
        executionResponse = await executeAssignAgent(action, contact)
        break
        
      case 'CREATE_TASK':
        executionResponse = await executeCreateTask(action, contact, agent)
        break
        
      case 'SCHEDULE_FOLLOWUP':
        executionResponse = await executeScheduleFollowup(action, contact)
        break
        
      default:
        throw new Error(`Unknown action type: ${action.action_type}`)
    }
    
    return {
      success: true,
      action_plan: action,
      executed_at: executedAt,
      execution_id: executionResponse.id,
      response: executionResponse
    }
    
  } catch (error) {
    console.error('[v0] Action execution failed:', error)
    return {
      success: false,
      action_plan: action,
      executed_at: executedAt,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Execute: Send Message (via System 3.1)
 */
async function executeSendMessage(action: ActionPlan, contact: any): Promise<any> {
  const supabase = await createClient()
  
  // Get message template or use default
  const messageContent = await resolveMessageTemplate(
    action.metadata.message_template,
    { contact, ...action.metadata }
  )
  
  // Determine channel
  const channel = action.metadata.channel || 'sms'
  
  // Insert message via System 3.1 pattern
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: action.metadata.conversation_id,
      direction: 'outbound',
      content: messageContent,
      channel,
      sender_type: 'agent',
      status: 'sent',
      metadata: {
        source: 'System 3.5 - Action Orchestration',
        action_reason: action.metadata.reason
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (error) throw error
  return data
}

/**
 * Execute: Send Email
 */
async function executeSendEmail(action: ActionPlan, contact: any): Promise<any> {
  const supabase = await createClient()
  
  if (!contact.email) {
    throw new Error('Contact has no email address')
  }
  
  const emailContent = await resolveMessageTemplate(
    action.metadata.message_template,
    { contact, ...action.metadata }
  )
  
  // Log email send activity (actual email sending via System 3.1)
  const { data, error } = await supabase
    .from('activities')
    .insert({
      type: 'EMAIL_SENT',
      entity_type: 'contact',
      entity_id: action.target_contact_id,
      metadata: {
        conversation_id: action.metadata.conversation_id,
        email: contact.email,
        subject: action.metadata.email_subject || 'Follow-up',
        content: emailContent,
        source: 'System 3.5',
        reason: action.metadata.reason
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (error) throw error
  return data
}

/**
 * Execute: Send SMS
 */
async function executeSendSMS(action: ActionPlan, contact: any): Promise<any> {
  const supabase = await createClient()
  
  if (!contact.phone) {
    throw new Error('Contact has no phone number')
  }
  
  const smsContent = await resolveMessageTemplate(
    action.metadata.message_template,
    { contact, ...action.metadata }
  )
  
  // Insert SMS message
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: action.metadata.conversation_id,
      direction: 'outbound',
      content: smsContent,
      channel: 'sms',
      sender_type: 'agent',
      status: 'sent',
      metadata: {
        source: 'System 3.5',
        reason: action.metadata.reason,
        phone: contact.phone
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (error) throw error
  return data
}

/**
 * Execute: Initiate Call
 */
async function executeInitiateCall(action: ActionPlan, contact: any, agent?: any): Promise<any> {
  const supabase = await createClient()
  
  if (!contact.phone) {
    throw new Error('Contact has no phone number')
  }
  
  // Create conversation for call
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: action.target_contact_id,
      channel: 'voice',
      status: 'pending',
      metadata: {
        source: 'System 3.5 - Orchestrated Call',
        reason: action.metadata.reason,
        priority: action.priority,
        agent_id: agent?.id
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (error) throw error
  return data
}

/**
 * Execute: Assign Agent
 */
async function executeAssignAgent(action: ActionPlan, contact: any): Promise<any> {
  const supabase = await createClient()
  
  // Find available agent matching criteria
  const requiredSkill = action.metadata.required_skill_level || 'mid'
  
  const { data: agent } = await supabase
    .from('agents')
    .select('*')
    .eq('status', 'available')
    .gte('skill_level', requiredSkill)
    .order('workload_score', { ascending: true })
    .limit(1)
    .single()
  
  if (!agent) {
    throw new Error('No available agents matching criteria')
  }
  
  // Update conversation with assigned agent
  if (action.metadata.conversation_id) {
    await supabase
      .from('conversations')
      .update({
        assigned_agent_id: agent.id,
        status: 'assigned',
        updated_at: new Date().toISOString()
      })
      .eq('id', action.metadata.conversation_id)
  }
  
  // Log assignment activity
  const { data, error } = await supabase
    .from('activities')
    .insert({
      type: 'AGENT_ASSIGNED',
      entity_type: 'conversation',
      entity_id: action.metadata.conversation_id,
      metadata: {
        agent_id: agent.id,
        agent_name: agent.name,
        contact_id: contact.id,
        reason: action.metadata.reason,
        priority: action.priority
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (error) throw error
  return data
}

/**
 * Execute: Create Task
 */
async function executeCreateTask(action: ActionPlan, contact: any, agent?: any): Promise<any> {
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from('activities')
    .insert({
      type: 'TASK_CREATED',
      entity_type: 'contact',
      entity_id: action.target_contact_id,
      metadata: {
        task_title: action.metadata.task_title || 'Follow-up required',
        task_description: action.metadata.reason,
        conversation_id: action.metadata.conversation_id,
        priority: action.priority,
        assigned_to: agent?.id,
        due_date: action.scheduled_for
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (error) throw error
  return data
}

/**
 * Execute: Schedule Follow-up
 */
async function executeScheduleFollowup(action: ActionPlan, contact: any): Promise<any> {
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from('activities')
    .insert({
      type: 'FOLLOWUP_SCHEDULED',
      entity_type: 'contact',
      entity_id: action.target_contact_id,
      metadata: {
        followup_type: action.metadata.followup_type,
        scheduled_for: action.scheduled_for,
        conversation_id: action.metadata.conversation_id,
        reason: action.metadata.reason,
        message_template: action.metadata.message_template
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (error) throw error
  return data
}

/**
 * Resolve message template to actual content
 */
async function resolveMessageTemplate(
  templateName: string | undefined,
  context: any
): Promise<string> {
  // Message templates for different scenarios
  const templates: Record<string, (ctx: any) => string> = {
    critical_escalation_alert: (ctx) => 
      `URGENT: Conversation ${ctx.conversation_id} requires immediate attention. Escalation signals: ${ctx.signals?.join(', ') || 'High priority issue detected'}.`,
    
    empathy_followup: (ctx) => 
      `Hi ${ctx.contact?.name || 'there'}, we noticed you may have had some concerns. We're here to help and want to ensure everything is resolved to your satisfaction. How can we assist you?`,
    
    health_check_followup: (ctx) => 
      `Hi ${ctx.contact?.name || 'there'}, we wanted to check in with you. Is there anything else we can help you with regarding your recent inquiry?`,
    
    isa_followup: (ctx) => 
      `Hi ${ctx.contact?.name || 'there'}, we wanted to follow up on our previous conversation. We'd love to complete your information to better serve you. When would be a good time to connect?`,
    
    positive_outcome_followup: (ctx) => 
      `Thank you ${ctx.contact?.name || 'so much'} for connecting with us! We're glad we could help. If you need anything else, we're always here for you.`,
    
    default: (ctx) => 
      `Hi ${ctx.contact?.name || 'there'}, this is a follow-up regarding ${ctx.reason || 'your recent conversation'}. Please let us know if you need any assistance.`
  }
  
  const template = templates[templateName || 'default'] || templates.default
  return template(context)
}

/**
 * Batch execute multiple actions
 */
export async function batchExecuteActions(
  actions: ActionPlan[],
  contactsMap: Map<string, any>,
  agentsMap?: Map<string, any>
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = []
  
  for (const action of actions) {
    const contact = contactsMap.get(action.target_contact_id)
    if (!contact) {
      results.push({
        success: false,
        action_plan: action,
        executed_at: new Date().toISOString(),
        error: 'Contact not found'
      })
      continue
    }
    
    const agent = action.metadata.agent_id 
      ? agentsMap?.get(action.metadata.agent_id)
      : undefined
    
    const result = await executeAction(action, contact, agent)
    results.push(result)
    
    // Delay between actions to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  
  return results
}
