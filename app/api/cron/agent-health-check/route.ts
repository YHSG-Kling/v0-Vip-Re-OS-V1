import {
NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { escalateToHuman } from '@/lib/intelligence/multi-agent-router'
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from '@/app/actions/cron-kernel'
import { verifyCronAuth } from "@/lib/cron-auth"

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/cron/agent-health-check
// Runs every 15 minutes. Detects stalled agent sessions and auto-escalates.
// Protected by CRON_SECRET Bearer token.
// ══════════════════════════════════════════════════════════════════════════════

// Session stale thresholds by agent type (in minutes)
const STALE_THRESHOLDS: Record<string, number> = {
  isa: 30,        // ISA should respond within 30 min
  tc: 60,         // TC has longer processing time
  coach: 120,     // Coaching reports can take time
  coordinator: 45, // Coordinator should handoff quickly
}

const DEFAULT_THRESHOLD = 60 // Default 1 hour

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: 'agent-health-check',
    cron_path: '/app/api/cron/agent-health-check/route.ts',
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: 'Failed to create cron context' }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error('[AgentHealthCheck] Failed to record cron start:', startRecordResult.error)
  }

  const supabase = createServiceClient()
  const now = new Date()
  const results = {
    checked: 0,
    stalled: 0,
    escalated: 0,
    errors: [] as string[],
  }
  
  try {
    // Get all active sessions
    const { data: activeSessions, error } = await supabase
      .from('agent_state_machine')
      .select('*')
      .eq('status', 'active')
      .is('human_override', false)
    
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    results.checked = activeSessions?.length || 0
    
    for (const session of activeSessions || []) {
      const threshold = STALE_THRESHOLDS[session.agent_type] || DEFAULT_THRESHOLD
      const startedAt = new Date(session.started_at)
      const ageMinutes = (now.getTime() - startedAt.getTime()) / (1000 * 60)
      
      // Check last_activity if available, otherwise use started_at
      const lastActivity = session.last_activity_at 
        ? new Date(session.last_activity_at)
        : startedAt
      const idleMinutes = (now.getTime() - lastActivity.getTime()) / (1000 * 60)
      
      // Session is stalled if idle for longer than threshold
      if (idleMinutes > threshold) {
        results.stalled++
        
        try {
          await escalateToHuman({
            sessionId: session.id,
            reason: `Agent session stalled - no activity for ${Math.round(idleMinutes)} minutes (threshold: ${threshold} min)`,
            urgency: idleMinutes > threshold * 2 ? 'high' : 'normal',
            suggestedAction: `Review ${session.entity_type} ${session.entity_id} and determine next steps`,
          })
          results.escalated++
        } catch (err) {
          results.errors.push(`Failed to escalate session ${session.id}: ${err}`)
        }
      }
    }
    
    // Also check for sessions stuck in "pending" state
    const { data: pendingSessions } = await supabase
      .from('agent_state_machine')
      .select('*')
      .eq('status', 'pending')
      .lt('created_at', new Date(now.getTime() - 30 * 60 * 1000).toISOString()) // > 30 min old
    
    for (const session of pendingSessions || []) {
      results.stalled++
      
      try {
        await escalateToHuman({
          sessionId: session.id,
          reason: 'Agent session stuck in pending state for over 30 minutes',
          urgency: 'high',
          suggestedAction: 'Investigate why agent session failed to start',
        })
        results.escalated++
      } catch (err) {
        results.errors.push(`Failed to escalate pending session ${session.id}: ${err}`)
      }
    }
    
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.checked,
      output_count: results.escalated,
      metadata: { ...results, timestamp: now.toISOString() },
    })

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      ...results,
    })

  } catch (err) {
    console.error('[AgentHealthCheck] Cron failed:', err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: 'main-processing' })
    return NextResponse.json(
      { error: `Health check failed: ${err}`, context_id: contextId },
      { status: 500 }
    )
  }
}
