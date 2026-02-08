/**
 * System 3.5 - Execution Logger & Error Handler
 * 
 * Logs all action executions to activities table.
 * Logs all errors to automation_errors table.
 */

import { createClient } from '@/lib/supabase/server'
import type { ActionPlan } from './orchestrator'
import type { ExecutionResult } from './execution-engine'

export interface ExecutionLog {
  log_id: string
  action_type: string
  priority: string
  conversation_id?: string
  contact_id: string
  status: 'success' | 'failed'
  executed_at: string
  error_message?: string
  metadata: any
}

/**
 * Log successful action execution
 */
export async function logExecution(result: ExecutionResult): Promise<void> {
  const supabase = await createClient()
  
  const logData = {
    type: result.success ? 'ACTION_EXECUTED' : 'ACTION_FAILED',
    entity_type: 'contact',
    entity_id: result.action_plan.target_contact_id,
    metadata: {
      action_type: result.action_plan.action_type,
      priority: result.action_plan.priority,
      conversation_id: result.action_plan.metadata.conversation_id,
      scheduled_for: result.action_plan.scheduled_for,
      executed_at: result.executed_at,
      execution_id: result.execution_id,
      success: result.success,
      error: result.error,
      reason: result.action_plan.metadata.reason,
      system: 'System 3.5 - Action Orchestration'
    },
    created_at: result.executed_at
  }
  
  const { error } = await supabase
    .from('activities')
    .insert(logData)
  
  if (error) {
    console.error('[v0] Failed to log execution:', error)
  }
}

/**
 * Log error to automation_errors table
 */
export async function logError(
  action: ActionPlan,
  error: Error | string,
  context?: any
): Promise<void> {
  const supabase = await createClient()
  
  const errorData = {
    system_name: 'System 3.5 - Action Orchestration',
    error_type: 'EXECUTION_ERROR',
    error_message: error instanceof Error ? error.message : error,
    context: {
      action_type: action.action_type,
      priority: action.priority,
      contact_id: action.target_contact_id,
      conversation_id: action.metadata.conversation_id,
      scheduled_for: action.scheduled_for,
      ...context
    },
    occurred_at: new Date().toISOString()
  }
  
  const { error: insertError } = await supabase
    .from('automation_errors')
    .insert(errorData)
  
  if (insertError) {
    console.error('[v0] Failed to log error to automation_errors:', insertError)
  }
}

/**
 * Batch log multiple execution results
 */
export async function batchLogExecutions(results: ExecutionResult[]): Promise<void> {
  const supabase = await createClient()
  
  const logEntries = results.map(result => ({
    type: result.success ? 'ACTION_EXECUTED' : 'ACTION_FAILED',
    entity_type: 'contact',
    entity_id: result.action_plan.target_contact_id,
    metadata: {
      action_type: result.action_plan.action_type,
      priority: result.action_plan.priority,
      conversation_id: result.action_plan.metadata.conversation_id,
      scheduled_for: result.action_plan.scheduled_for,
      executed_at: result.executed_at,
      execution_id: result.execution_id,
      success: result.success,
      error: result.error,
      reason: result.action_plan.metadata.reason,
      system: 'System 3.5 - Action Orchestration'
    },
    created_at: result.executed_at
  }))
  
  const { error } = await supabase
    .from('activities')
    .insert(logEntries)
  
  if (error) {
    console.error('[v0] Failed to batch log executions:', error)
  }
}

/**
 * Batch log errors
 */
export async function batchLogErrors(
  failedResults: ExecutionResult[]
): Promise<void> {
  const supabase = await createClient()
  
  const errorEntries = failedResults
    .filter(result => !result.success)
    .map(result => ({
      system_name: 'System 3.5 - Action Orchestration',
      error_type: 'EXECUTION_ERROR',
      error_message: result.error || 'Unknown error',
      context: {
        action_type: result.action_plan.action_type,
        priority: result.action_plan.priority,
        contact_id: result.action_plan.target_contact_id,
        conversation_id: result.action_plan.metadata.conversation_id,
        scheduled_for: result.action_plan.scheduled_for
      },
      occurred_at: result.executed_at
    }))
  
  if (errorEntries.length === 0) return
  
  const { error } = await supabase
    .from('automation_errors')
    .insert(errorEntries)
  
  if (error) {
    console.error('[v0] Failed to batch log errors:', error)
  }
}

/**
 * Get execution logs for a conversation
 */
export async function getExecutionLogs(
  conversationId: string
): Promise<ExecutionLog[]> {
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .in('type', ['ACTION_EXECUTED', 'ACTION_FAILED'])
    .eq('metadata->>conversation_id', conversationId)
    .order('created_at', { ascending: false })
  
  if (error) {
    console.error('[v0] Failed to get execution logs:', error)
    return []
  }
  
  return (data || []).map(activity => ({
    log_id: activity.id,
    action_type: activity.metadata.action_type,
    priority: activity.metadata.priority,
    conversation_id: activity.metadata.conversation_id,
    contact_id: activity.entity_id,
    status: activity.metadata.success ? 'success' : 'failed',
    executed_at: activity.metadata.executed_at,
    error_message: activity.metadata.error,
    metadata: activity.metadata
  }))
}

/**
 * Get execution statistics for a time period
 */
export async function getExecutionStats(
  startDate: string,
  endDate: string
): Promise<{
  total_executions: number
  successful: number
  failed: number
  by_action_type: Record<string, number>
  by_priority: Record<string, number>
}> {
  const supabase = await createClient()
  
  const { data } = await supabase
    .from('activities')
    .select('*')
    .in('type', ['ACTION_EXECUTED', 'ACTION_FAILED'])
    .gte('created_at', startDate)
    .lte('created_at', endDate)
  
  if (!data) {
    return {
      total_executions: 0,
      successful: 0,
      failed: 0,
      by_action_type: {},
      by_priority: {}
    }
  }
  
  const successful = data.filter(d => d.metadata.success).length
  const failed = data.filter(d => !d.metadata.success).length
  
  const byActionType: Record<string, number> = {}
  const byPriority: Record<string, number> = {}
  
  for (const activity of data) {
    const actionType = activity.metadata.action_type
    const priority = activity.metadata.priority
    
    byActionType[actionType] = (byActionType[actionType] || 0) + 1
    byPriority[priority] = (byPriority[priority] || 0) + 1
  }
  
  return {
    total_executions: data.length,
    successful,
    failed,
    by_action_type: byActionType,
    by_priority: byPriority
  }
}

/**
 * Get recent errors
 */
export async function getRecentErrors(
  limit: number = 50
): Promise<any[]> {
  const supabase = await createClient()
  
  const { data } = await supabase
    .from('automation_errors')
    .select('*')
    .eq('system_name', 'System 3.5 - Action Orchestration')
    .order('occurred_at', { ascending: false })
    .limit(limit)
  
  return data || []
}

/**
 * Log orchestration cycle completion
 */
export async function logOrchestrationCycle(stats: {
  signals_processed: number
  decisions_made: number
  actions_executed: number
  actions_successful: number
  actions_failed: number
  cycle_duration_ms: number
}): Promise<void> {
  const supabase = await createClient()
  
  await supabase
    .from('activities')
    .insert({
      type: 'ORCHESTRATION_CYCLE_COMPLETE',
      entity_type: 'system',
      entity_id: 'system-3-5',
      metadata: {
        ...stats,
        system: 'System 3.5 - Action Orchestration'
      },
      created_at: new Date().toISOString()
    })
}
