/**
 * System 3.5 - Action Orchestration & Follow-Up Execution Engine
 * Server Actions Integration Layer
 * 
 * Provides callable server actions for orchestrating and executing follow-up actions.
 */

'use server'

import { createClient } from '@/lib/supabase/server'
import { 
  monitorAndDecide, 
  getLastProcessedTimestamp,
  saveCheckpoint,
  filterSignalsByPriority,
  type EscalationSignal 
} from '@/lib/action-orchestration/signal-monitor'
import {
  analyzeInsightsForAction,
  prioritizeActions,
  isActionDue,
  selectOptimalChannel,
  validateActionPlan,
  type ActionPlan,
  type OrchestratorDecision
} from '@/lib/action-orchestration/orchestrator'
import {
  executeAction,
  batchExecuteActions,
  type ExecutionResult
} from '@/lib/action-orchestration/execution-engine'
import {
  logExecution,
  logError,
  batchLogExecutions,
  batchLogErrors,
  logOrchestrationCycle,
  getExecutionLogs,
  getExecutionStats,
  getRecentErrors
} from '@/lib/action-orchestration/execution-logger'

/**
 * Main orchestration loop - to be called on a schedule (e.g., every 5 minutes)
 */
export async function runOrchestrationCycle() {
  const startTime = Date.now()
  const supabase = await createClient()
  
  try {
    console.log('[v0] Starting orchestration cycle...')
    
    // Get last processed timestamp
    const lastProcessed = await getLastProcessedTimestamp()
    console.log('[v0] Last processed:', lastProcessed)
    
    // Monitor for signals and generate decisions
    const { signals_found, decisions_made, decisions } = await monitorAndDecide(lastProcessed)
    console.log('[v0] Signals found:', signals_found, 'Decisions made:', decisions_made)
    
    if (decisions.size === 0) {
      await saveCheckpoint(new Date().toISOString())
      return {
        success: true,
        message: 'No actions needed',
        stats: {
          signals_processed: signals_found,
          decisions_made: 0,
          actions_executed: 0
        }
      }
    }
    
    // Collect all action plans
    const allActions: ActionPlan[] = []
    for (const [conversationId, decision] of decisions) {
      const prioritized = prioritizeActions(decision.actions)
      allActions.push(...prioritized)
    }
    
    // Filter to only actions that are due
    const dueActions = allActions.filter(isActionDue)
    console.log('[v0] Due actions:', dueActions.length)
    
    if (dueActions.length === 0) {
      await saveCheckpoint(new Date().toISOString())
      return {
        success: true,
        message: 'No due actions',
        stats: {
          signals_processed: signals_found,
          decisions_made: decisions_made,
          actions_scheduled: allActions.length,
          actions_executed: 0
        }
      }
    }
    
    // Fetch contacts for all actions
    const contactIds = [...new Set(dueActions.map(a => a.target_contact_id))]
    const { data: contacts } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds)
    
    const contactsMap = new Map(contacts?.map(c => [c.id, c]) || [])
    
    // Execute actions
    const results = await batchExecuteActions(dueActions, contactsMap)
    console.log('[v0] Execution results:', results.length)
    
    // Log all executions
    await batchLogExecutions(results)
    
    // Log errors
    const failedResults = results.filter(r => !r.success)
    if (failedResults.length > 0) {
      await batchLogErrors(failedResults)
    }
    
    // Save checkpoint
    await saveCheckpoint(new Date().toISOString())
    
    // Log cycle completion
    const cycleDuration = Date.now() - startTime
    await logOrchestrationCycle({
      signals_processed: signals_found,
      decisions_made: decisions_made,
      actions_executed: results.length,
      actions_successful: results.filter(r => r.success).length,
      actions_failed: failedResults.length,
      cycle_duration_ms: cycleDuration
    })
    
    return {
      success: true,
      stats: {
        signals_processed: signals_found,
        decisions_made: decisions_made,
        actions_executed: results.length,
        actions_successful: results.filter(r => r.success).length,
        actions_failed: failedResults.length,
        cycle_duration_ms: cycleDuration
      }
    }
    
  } catch (error) {
    console.error('[v0] Orchestration cycle error:', error)
    
    // Log system error
    await supabase.from('automation_errors').insert({
      system_name: 'System 3.5 - Action Orchestration',
      error_type: 'ORCHESTRATION_CYCLE_ERROR',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      context: { lastProcessed: await getLastProcessedTimestamp() },
      occurred_at: new Date().toISOString()
    })
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Manually trigger orchestration for a specific conversation
 */
export async function orchestrateConversation(conversationId: string) {
  const supabase = await createClient()
  
  try {
    // Get conversation insights
    const { data: insight, error } = await supabase
      .from('conversation_insights')
      .select('*')
      .eq('conversation_id', conversationId)
      .single()
    
    if (error || !insight) {
      return { success: false, error: 'Conversation insights not found' }
    }
    
    // Generate decision
    const decision = analyzeInsightsForAction(insight)
    
    if (!decision.should_act) {
      return {
        success: true,
        message: 'No action needed',
        reasoning: decision.reasoning
      }
    }
    
    // Get contact
    const { data: conversation } = await supabase
      .from('conversations')
      .select('contact_id, contacts(*)')
      .eq('id', conversationId)
      .single()
    
    if (!conversation) {
      return { success: false, error: 'Conversation not found' }
    }
    
    const contact = conversation.contacts
    
    // Execute due actions
    const dueActions = decision.actions.filter(isActionDue)
    const results: ExecutionResult[] = []
    
    for (const action of dueActions) {
      const result = await executeAction(action, contact)
      results.push(result)
      await logExecution(result)
      
      if (!result.success) {
        await logError(action, result.error || 'Unknown error')
      }
    }
    
    return {
      success: true,
      decision,
      actions_executed: results.length,
      results
    }
    
  } catch (error) {
    console.error('[v0] Conversation orchestration error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Get pending actions for a conversation
 */
export async function getPendingActions(conversationId: string) {
  const supabase = await createClient()
  
  try {
    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('*')
      .eq('conversation_id', conversationId)
      .single()
    
    if (!insight) {
      return { success: false, error: 'No insights found' }
    }
    
    const decision = analyzeInsightsForAction(insight)
    
    if (!decision.should_act) {
      return {
        success: true,
        pending_actions: [],
        reasoning: decision.reasoning
      }
    }
    
    return {
      success: true,
      pending_actions: decision.actions,
      reasoning: decision.reasoning,
      confidence: decision.confidence
    }
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Get execution history for a conversation
 */
export async function getConversationExecutionHistory(conversationId: string) {
  try {
    const logs = await getExecutionLogs(conversationId)
    return {
      success: true,
      history: logs
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Get orchestration statistics for a time period
 */
export async function getOrchestrationStats(startDate: string, endDate: string) {
  try {
    const stats = await getExecutionStats(startDate, endDate)
    return {
      success: true,
      stats
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Get recent orchestration errors
 */
export async function getOrchestrationErrors(limit: number = 50) {
  try {
    const errors = await getRecentErrors(limit)
    return {
      success: true,
      errors
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Process high priority signals immediately
 */
export async function processUrgentSignals() {
  const startTime = Date.now()
  const supabase = await createClient()
  
  try {
    // Get recent signals (last 15 minutes)
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { signals_found, decisions } = await monitorAndDecide(since)
    
    // Collect CRITICAL and HIGH priority actions only
    const urgentActions: ActionPlan[] = []
    for (const [conversationId, decision] of decisions) {
      const critical = decision.actions.filter(
        a => a.priority === 'CRITICAL' || a.priority === 'HIGH'
      )
      urgentActions.push(...critical)
    }
    
    if (urgentActions.length === 0) {
      return {
        success: true,
        message: 'No urgent actions found',
        signals_checked: signals_found
      }
    }
    
    // Fetch contacts
    const contactIds = [...new Set(urgentActions.map(a => a.target_contact_id))]
    const { data: contacts } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds)
    
    const contactsMap = new Map(contacts?.map(c => [c.id, c]) || [])
    
    // Execute immediately
    const results = await batchExecuteActions(urgentActions, contactsMap)
    await batchLogExecutions(results)
    
    const failedResults = results.filter(r => !r.success)
    if (failedResults.length > 0) {
      await batchLogErrors(failedResults)
    }
    
    return {
      success: true,
      stats: {
        signals_checked: signals_found,
        urgent_actions_executed: results.length,
        successful: results.filter(r => r.success).length,
        failed: failedResults.length,
        duration_ms: Date.now() - startTime
      }
    }
    
  } catch (error) {
    console.error('[v0] Urgent signal processing error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Test action execution (for development)
 */
export async function testActionExecution(
  actionType: ActionPlan['action_type'],
  contactId: string,
  conversationId?: string
) {
  const supabase = await createClient()
  
  try {
    const { data: contact } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single()
    
    if (!contact) {
      return { success: false, error: 'Contact not found' }
    }
    
    const testAction: ActionPlan = {
      action_type: actionType,
      priority: 'LOW',
      target_contact_id: contactId,
      scheduled_for: new Date().toISOString(),
      metadata: {
        reason: 'Test execution',
        conversation_id: conversationId,
        message_template: 'default'
      }
    }
    
    const validation = validateActionPlan(testAction, contact)
    if (!validation.valid) {
      return {
        success: false,
        error: 'Validation failed',
        validation_errors: validation.errors
      }
    }
    
    const result = await executeAction(testAction, contact)
    await logExecution(result)
    
    return {
      success: result.success,
      result
    }
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
