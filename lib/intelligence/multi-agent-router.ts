"use server"

import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { AGENT_REGISTRY, type AgentType, type AgentCapability } from './agent-registry'

// ══════════════════════════════════════════════════════════════════════════════
// Multi-Agent Router — L12-P07
// Single entry point for all AI agent dispatch. Routes tasks to appropriate
// specialist agents, manages handoffs, and handles human override flags.
// ══════════════════════════════════════════════════════════════════════════════

export interface RouteRequest {
  entityType: 'lead' | 'contact' | 'transaction' | 'showing' | 'task'
  entityId: string
  brokerageId: string
  agentId?: string // Human agent, if assigned
  capability: AgentCapability
  context?: Record<string, unknown>
  priority?: 'low' | 'normal' | 'high' | 'urgent'
}

export interface RouteResult {
  success: boolean
  sessionId?: string
  agentType?: AgentType
  message: string
  blockedByHumanOverride?: boolean
}

/**
 * Check if entity has human override flag set
 */
async function checkHumanOverride(
  entityType: string,
  entityId: string
): Promise<boolean> {
  const supabase = createServiceClient()
  
  const { data } = await supabase
    .from('agent_state_machine')
    .select('human_override')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .single()
  
  return data?.human_override === true
}

/**
 * Find the best agent for a given capability
 */
function findAgentForCapability(capability: AgentCapability): AgentType | null {
  for (const [agentType, config] of Object.entries(AGENT_REGISTRY)) {
    if ((config.handles as readonly string[]).includes(capability as string)) {
      return agentType as AgentType
    }
  }
  return null
}

/**
 * Main routing function — single entry point for all agent dispatch
 */
export async function routeToAgent(request: RouteRequest): Promise<RouteResult> {
  const supabase = createServiceClient()
  
  // Step 1: Check human override flag
  const hasOverride = await checkHumanOverride(request.entityType, request.entityId)
  if (hasOverride) {
    return {
      success: false,
      message: 'Entity has human override flag - AI agents blocked',
      blockedByHumanOverride: true,
    }
  }
  
  // Step 2: Find appropriate agent for capability
  const agentType = findAgentForCapability(request.capability)
  if (!agentType || agentType === 'none' || agentType === 'human') {
    return {
      success: false,
      message: `No agent found for capability: ${request.capability}`,
    }
  }
  
  const agentConfig = AGENT_REGISTRY[agentType as keyof typeof AGENT_REGISTRY]
  
  // Step 3: Check for existing active session on this entity
  const { data: existingSession } = await supabase
    .from('agent_state_machine')
    .select('*')
    .eq('entity_type', request.entityType)
    .eq('entity_id', request.entityId)
    .eq('status', 'active')
    .single()
  
  // Step 4: If different agent type is active, initiate handoff
  if (existingSession && existingSession.agent_type !== agentType) {
    return await initiateHandoff({
      fromSessionId: existingSession.id,
      fromAgentType: existingSession.agent_type,
      toAgentType: agentType,
      entityType: request.entityType,
      entityId: request.entityId,
      brokerageId: request.brokerageId,
      reason: `Capability ${request.capability} requires ${agentType}`,
      context: request.context,
    })
  }
  
  // Step 5: If same agent type is active, return existing session
  if (existingSession && existingSession.agent_type === agentType) {
    return {
      success: true,
      sessionId: existingSession.id,
      agentType,
      message: `Using existing ${agentType} session`,
    }
  }
  
  // Step 6: Create new agent session
  const { data: newSession, error } = await supabase
    .from('agent_state_machine')
    .insert({
      agent_type: agentType,
      entity_type: request.entityType,
      entity_id: request.entityId,
      brokerage_id: request.brokerageId,
      assigned_agent_id: request.agentId,
      status: 'active',
      current_state: (agentConfig as any).initialState ?? null,
      context: request.context || {},
      priority: request.priority || 'normal',
      started_at: new Date().toISOString(),
    })
    .select()
    .single()
  
  if (error) {
    // Handle unique constraint violation (concurrent dispatch)
    if (error.code === '23505') {
      // Re-fetch and return existing session
      const { data: existing } = await supabase
        .from('agent_state_machine')
        .select('*')
        .eq('entity_type', request.entityType)
        .eq('entity_id', request.entityId)
        .eq('status', 'active')
        .single()
      
      if (existing) {
        return {
          success: true,
          sessionId: existing.id,
          agentType: existing.agent_type,
          message: `Using existing ${existing.agent_type} session (concurrent dispatch)`,
        }
      }
    }
    
    return {
      success: false,
      message: `Failed to create agent session: ${error.message}`,
    }
  }
  
  // Step 7: Log kernel event
  await supabase.from('lifecycle_events').insert({
    event_type: KernelEvent.AGENT_SESSION_STARTED,
    entity_type: request.entityType,
    entity_id: request.entityId,
    brokerage_id: request.brokerageId,
    agent_id: request.agentId,
    payload: {
      session_id: newSession.id,
      agent_type: agentType,
      capability: request.capability,
      priority: request.priority || 'normal',
    },
  })
  
  // Step 8: Dispatch task
  await supabase.from('lifecycle_events').insert({
    event_type: KernelEvent.AGENT_TASK_DISPATCHED,
    entity_type: request.entityType,
    entity_id: request.entityId,
    brokerage_id: request.brokerageId,
    agent_id: request.agentId,
    payload: {
      session_id: newSession.id,
      agent_type: agentType,
      capability: request.capability,
      context: request.context,
    },
  })
  
  return {
    success: true,
    sessionId: newSession.id,
    agentType,
    message: `Started new ${agentType} session for ${request.capability}`,
  }
}

interface HandoffRequest {
  fromSessionId: string
  fromAgentType: AgentType
  toAgentType: AgentType
  entityType: string
  entityId: string
  brokerageId: string
  reason: string
  context?: Record<string, unknown>
}

/**
 * Initiate handoff between two agents
 */
async function initiateHandoff(request: HandoffRequest): Promise<RouteResult> {
  const supabase = createServiceClient()
  
  // Log handoff initiated event
  await supabase.from('lifecycle_events').insert({
    event_type: KernelEvent.AGENT_HANDOFF_INITIATED,
    entity_type: request.entityType,
    entity_id: request.entityId,
    brokerage_id: request.brokerageId,
    payload: {
      from_session_id: request.fromSessionId,
      from_agent_type: request.fromAgentType,
      to_agent_type: request.toAgentType,
      reason: request.reason,
    },
  })
  
  // End the current session
  await supabase
    .from('agent_state_machine')
    .update({
      status: 'handed_off',
      ended_at: new Date().toISOString(),
      handoff_to: request.toAgentType,
      handoff_reason: request.reason,
    })
    .eq('id', request.fromSessionId)
  
  // Create new session for the receiving agent
  if (request.toAgentType === 'none' || request.toAgentType === 'human') {
    return {
      success: false,
      message: 'Cannot handoff to none/human agent type',
    }
  }
  const toAgentConfig = AGENT_REGISTRY[request.toAgentType as keyof typeof AGENT_REGISTRY]
  
  const { data: newSession, error } = await supabase
    .from('agent_state_machine')
    .insert({
      agent_type: request.toAgentType,
      entity_type: request.entityType,
      entity_id: request.entityId,
      brokerage_id: request.brokerageId,
      status: 'active',
      current_state: (toAgentConfig as any).initialState ?? null,
      context: {
        ...request.context,
        handoff_from: request.fromAgentType,
        handoff_session_id: request.fromSessionId,
        handoff_reason: request.reason,
      },
      priority: 'high', // Handoffs get elevated priority
      started_at: new Date().toISOString(),
    })
    .select()
    .single()
  
  if (error) {
    return {
      success: false,
      message: `Failed to complete handoff: ${error.message}`,
    }
  }
  
  // Log handoff completed event
  await supabase.from('lifecycle_events').insert({
    event_type: KernelEvent.AGENT_HANDOFF_COMPLETED,
    entity_type: request.entityType,
    entity_id: request.entityId,
    brokerage_id: request.brokerageId,
    payload: {
      from_session_id: request.fromSessionId,
      from_agent_type: request.fromAgentType,
      to_session_id: newSession.id,
      to_agent_type: request.toAgentType,
      reason: request.reason,
    },
  })
  
  return {
    success: true,
    sessionId: newSession.id,
    agentType: request.toAgentType,
    message: `Handed off from ${request.fromAgentType} to ${request.toAgentType}`,
  }
}

/**
 * Escalate to human agent
 */
export async function escalateToHuman(params: {
  sessionId: string
  reason: string
  urgency: 'low' | 'normal' | 'high' | 'critical'
  suggestedAction?: string
}): Promise<{ success: boolean; message: string }> {
  const supabase = createServiceClient()
  
  // Get session details
  const { data: session } = await supabase
    .from('agent_state_machine')
    .select('*')
    .eq('id', params.sessionId)
    .single()
  
  if (!session) {
    return { success: false, message: 'Session not found' }
  }
  
  // Set human override flag
  await supabase
    .from('agent_state_machine')
    .update({
      status: 'escalated',
      human_override: true,
      ended_at: new Date().toISOString(),
      escalation_reason: params.reason,
      escalation_urgency: params.urgency,
    })
    .eq('id', params.sessionId)
  
  // Create smart assistant suggestion for human agent
  await supabase.from('smart_assistant_suggestions').insert({
    brokerage_id: session.brokerage_id,
    agent_id: session.assigned_agent_id,
    suggestion_type: 'agent_escalation',
    title: `AI Agent Escalation: ${session.agent_type}`,
    description: params.reason,
    // smart_assistant_suggestions.priority is constrained to low/medium/high; map critical -> high.
    priority: params.urgency === 'critical' ? 'high' : params.urgency,
    action_url: `/${session.entity_type}s/${session.entity_id}`,
    metadata: {
      session_id: params.sessionId,
      agent_type: session.agent_type,
      entity_type: session.entity_type,
      entity_id: session.entity_id,
      suggested_action: params.suggestedAction,
    },
  })
  
  // Log kernel event
  await supabase.from('lifecycle_events').insert({
    event_type: KernelEvent.AGENT_ESCALATED_TO_HUMAN,
    entity_type: session.entity_type,
    entity_id: session.entity_id,
    brokerage_id: session.brokerage_id,
    agent_id: session.assigned_agent_id,
    payload: {
      session_id: params.sessionId,
      agent_type: session.agent_type,
      reason: params.reason,
      urgency: params.urgency,
      suggested_action: params.suggestedAction,
    },
  })
  
  return {
    success: true,
    message: `Escalated to human agent with ${params.urgency} urgency`,
  }
}

/**
 * End an agent session
 */
export async function endAgentSession(params: {
  sessionId: string
  outcome: 'completed' | 'failed' | 'cancelled'
  summary?: string
}): Promise<{ success: boolean; message: string }> {
  const supabase = createServiceClient()
  
  const { data: session } = await supabase
    .from('agent_state_machine')
    .select('*')
    .eq('id', params.sessionId)
    .single()
  
  if (!session) {
    return { success: false, message: 'Session not found' }
  }
  
  await supabase
    .from('agent_state_machine')
    .update({
      status: params.outcome,
      ended_at: new Date().toISOString(),
      outcome_summary: params.summary,
    })
    .eq('id', params.sessionId)
  
  await supabase.from('lifecycle_events').insert({
    event_type: KernelEvent.AGENT_SESSION_ENDED,
    entity_type: session.entity_type,
    entity_id: session.entity_id,
    brokerage_id: session.brokerage_id,
    agent_id: session.assigned_agent_id,
    payload: {
      session_id: params.sessionId,
      agent_type: session.agent_type,
      outcome: params.outcome,
      summary: params.summary,
      duration_ms: session.started_at 
        ? Date.now() - new Date(session.started_at).getTime() 
        : null,
    },
  })
  
  return { success: true, message: `Session ended with outcome: ${params.outcome}` }
}

/**
 * Clear human override flag, allowing AI to resume
 */
export async function clearHumanOverride(params: {
  entityType: string
  entityId: string
}): Promise<{ success: boolean; message: string }> {
  const supabase = createServiceClient()
  
  const { error } = await supabase
    .from('agent_state_machine')
    .update({ human_override: false })
    .eq('entity_type', params.entityType)
    .eq('entity_id', params.entityId)
  
  if (error) {
    return { success: false, message: error.message }
  }
  
  return { success: true, message: 'Human override cleared - AI agents can resume' }
}

/**
 * Get current agent session for an entity
 */
export async function getActiveSession(params: {
  entityType: string
  entityId: string
}): Promise<{
  session: {
    id: string
    agent_type: AgentType
    status: string
    current_state: string
    human_override: boolean
    started_at: string
    context: Record<string, unknown>
  } | null
}> {
  const supabase = createServiceClient()
  
  const { data } = await supabase
    .from('agent_state_machine')
    .select('*')
    .eq('entity_type', params.entityType)
    .eq('entity_id', params.entityId)
    .eq('status', 'active')
    .single()
  
  return { session: data }
}

/**
 * Get all active sessions for a brokerage (for dashboard)
 */
export async function getActiveSessions(brokerageId: string): Promise<{
  sessions: Array<{
    id: string
    agent_type: AgentType
    entity_type: string
    entity_id: string
    status: string
    current_state: string
    priority: string
    started_at: string
    human_override: boolean
  }>
}> {
  const supabase = createServiceClient()
  
  const { data } = await supabase
    .from('agent_state_machine')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(100)
  
  return { sessions: data || [] }
}

/**
 * Get agent performance metrics
 */
export async function getAgentMetrics(brokerageId: string, daysBack: number = 7): Promise<{
  byAgentType: Record<AgentType, {
    totalSessions: number
    completed: number
    escalated: number
    avgDurationMs: number
  }>
  totalSessions: number
  escalationRate: number
}> {
  const supabase = createServiceClient()
  
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - daysBack)
  
  const { data: sessions } = await supabase
    .from('agent_state_machine')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .gte('started_at', cutoff.toISOString())
  
  const byAgentType: Record<string, {
    totalSessions: number
    completed: number
    escalated: number
    totalDurationMs: number
  }> = {}
  
  let totalEscalated = 0
  
  for (const session of sessions || []) {
    const type = session.agent_type
    if (!byAgentType[type]) {
      byAgentType[type] = { totalSessions: 0, completed: 0, escalated: 0, totalDurationMs: 0 }
    }
    
    byAgentType[type].totalSessions++
    
    if (session.status === 'completed') {
      byAgentType[type].completed++
    }
    if (session.status === 'escalated') {
      byAgentType[type].escalated++
      totalEscalated++
    }
    
    if (session.started_at && session.ended_at) {
      const duration = new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()
      byAgentType[type].totalDurationMs += duration
    }
  }
  
  const result: Record<string, {
    totalSessions: number
    completed: number
    escalated: number
    avgDurationMs: number
  }> = {}
  
  for (const [type, metrics] of Object.entries(byAgentType)) {
    result[type] = {
      totalSessions: metrics.totalSessions,
      completed: metrics.completed,
      escalated: metrics.escalated,
      avgDurationMs: metrics.totalSessions > 0 
        ? Math.round(metrics.totalDurationMs / metrics.totalSessions)
        : 0,
    }
  }
  
  const totalSessions = sessions?.length || 0
  
  return {
    byAgentType: result as Record<AgentType, typeof result[string]>,
    totalSessions,
    escalationRate: totalSessions > 0 ? totalEscalated / totalSessions : 0,
  }
}
