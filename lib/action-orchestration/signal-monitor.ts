/**
 * System 3.5 - Escalation Signal Monitor
 * 
 * Monitors conversation_insights and activities tables for escalation signals.
 * Reads signals emitted by System 3.4 and triggers orchestrator decisions.
 */

import { createClient } from '@/lib/supabase/server'
import { analyzeInsightsForAction, type OrchestratorDecision } from './orchestrator'

export interface EscalationSignal {
  signal_id: string
  conversation_id: string
  priority: 'CRITICAL' | 'URGENT' | 'HIGH' | 'MEDIUM'
  signal_type: string
  emitted_at: string
  metadata: any
}

/**
 * Poll conversation_insights for new escalations
 */
export async function pollEscalationSignals(
  sinceDatetime: string
): Promise<EscalationSignal[]> {
  const supabase = await createClient()
  
  const { data: insights, error } = await supabase
    .from('conversation_insights')
    .select('*')
    .eq('should_escalate', true)
    .gte('analyzed_at', sinceDatetime)
    .order('analyzed_at', { ascending: true })
  
  if (error) {
    console.error('[v0] Failed to poll escalation signals:', error)
    return []
  }
  
  return (insights || []).map(insight => ({
    signal_id: insight.id,
    conversation_id: insight.conversation_id,
    priority: insight.escalation_priority,
    signal_type: 'ESCALATION_SIGNAL',
    emitted_at: insight.analyzed_at,
    metadata: {
      escalation_signals: insight.escalation_signals,
      health_score: insight.health_score,
      sentiment_label: insight.sentiment_label,
      sentiment_score: insight.sentiment_score,
      isa_compliance_score: insight.isa_compliance_score
    }
  }))
}

/**
 * Poll activities table for urgent signals from System 3.4
 */
export async function pollActivitySignals(
  sinceDatetime: string
): Promise<EscalationSignal[]> {
  const supabase = await createClient()
  
  const { data: activities, error } = await supabase
    .from('activities')
    .select('*')
    .in('type', [
      'ESCALATION_SIGNAL',
      'URGENT_ESCALATION_SIGNAL',
      'CRITICAL_ESCALATION_SIGNAL',
      'ISA_VALIDATION_REVIEW_SIGNAL'
    ])
    .gte('created_at', sinceDatetime)
    .order('created_at', { ascending: true })
  
  if (error) {
    console.error('[v0] Failed to poll activity signals:', error)
    return []
  }
  
  return (activities || []).map(activity => ({
    signal_id: activity.id,
    conversation_id: activity.entity_id,
    priority: activity.metadata?.priority || 'MEDIUM',
    signal_type: activity.type,
    emitted_at: activity.created_at,
    metadata: activity.metadata
  }))
}

/**
 * Unified signal polling: Check both sources
 */
export async function pollAllSignals(
  sinceDatetime: string
): Promise<EscalationSignal[]> {
  const [insightSignals, activitySignals] = await Promise.all([
    pollEscalationSignals(sinceDatetime),
    pollActivitySignals(sinceDatetime)
  ])
  
  // Combine and deduplicate by conversation_id (keep most recent)
  const signalMap = new Map<string, EscalationSignal>()
  
  for (const signal of [...insightSignals, ...activitySignals]) {
    const existing = signalMap.get(signal.conversation_id)
    if (!existing || new Date(signal.emitted_at) > new Date(existing.emitted_at)) {
      signalMap.set(signal.conversation_id, signal)
    }
  }
  
  return Array.from(signalMap.values())
}

/**
 * Process signals and generate orchestrator decisions
 */
export async function processSignals(
  signals: EscalationSignal[]
): Promise<Map<string, OrchestratorDecision>> {
  const supabase = await createClient()
  const decisions = new Map<string, OrchestratorDecision>()
  
  // Fetch full insights for each signal
  for (const signal of signals) {
    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('*')
      .eq('conversation_id', signal.conversation_id)
      .single()
    
    if (insight) {
      // Enrich with signal metadata
      const enrichedInsight = {
        ...insight,
        metadata: {
          ...insight.metadata,
          signal_priority: signal.priority,
          signal_type: signal.signal_type
        }
      }
      
      const decision = analyzeInsightsForAction(enrichedInsight)
      
      if (decision.should_act) {
        decisions.set(signal.conversation_id, decision)
      }
    }
  }
  
  return decisions
}

/**
 * Monitor loop: Poll for signals and generate decisions
 */
export async function monitorAndDecide(
  sinceDatetime: string
): Promise<{
  signals_found: number
  decisions_made: number
  decisions: Map<string, OrchestratorDecision>
}> {
  const signals = await pollAllSignals(sinceDatetime)
  const decisions = await processSignals(signals)
  
  return {
    signals_found: signals.length,
    decisions_made: decisions.size,
    decisions
  }
}

/**
 * Get last processed timestamp from activities table
 */
export async function getLastProcessedTimestamp(): Promise<string> {
  const supabase = await createClient()
  
  const { data } = await supabase
    .from('activities')
    .select('created_at')
    .eq('type', 'ACTION_ORCHESTRATION_CHECKPOINT')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  
  // Default to 1 hour ago if no checkpoint found
  return data?.created_at || new Date(Date.now() - 60 * 60 * 1000).toISOString()
}

/**
 * Save checkpoint timestamp
 */
export async function saveCheckpoint(timestamp: string): Promise<void> {
  const supabase = await createClient()
  
  await supabase
    .from('activities')
    .insert({
      type: 'ACTION_ORCHESTRATION_CHECKPOINT',
      entity_type: 'system',
      entity_id: 'system-3-5',
      metadata: {
        checkpoint_time: timestamp,
        system: 'System 3.5 - Action Orchestration'
      },
      created_at: new Date().toISOString()
    })
}

/**
 * Filter signals by priority threshold
 */
export function filterSignalsByPriority(
  signals: EscalationSignal[],
  minPriority: 'CRITICAL' | 'URGENT' | 'HIGH' | 'MEDIUM'
): EscalationSignal[] {
  const priorityLevels = {
    CRITICAL: 4,
    URGENT: 3,
    HIGH: 2,
    MEDIUM: 1
  }
  
  const threshold = priorityLevels[minPriority]
  
  return signals.filter(signal => {
    const signalLevel = priorityLevels[signal.priority] || 0
    return signalLevel >= threshold
  })
}
