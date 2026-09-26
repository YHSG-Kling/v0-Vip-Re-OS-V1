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
// Runs every 15 minutes. Protected by CRON_SECRET Bearer token.
//
// Two session surfaces, both of which go stale silently:
//   1. agent_state_machine        — our own in-process sessions. Stalled/pending
//                                   rows are escalated to a human.
//   2. managed_agent_sessions     — mirrors a LIVE Anthropic Managed Agents
//                                   session. Driven only by the anthropic-agent
//                                   webhook, so a dropped delivery leaves the row
//                                   'running' forever and the admin console shows
//                                   an agent still working on a finished session.
//                                   Stale non-terminal rows are re-probed against
//                                   /v1/sessions/{id} and reconciled. See the
//                                   block at the end of GET.
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
    
    // ── Managed-agent sessions: reconcile against Anthropic ──────────────────
    //
    // A SECOND session table, and until now nothing watched it. `agent_state_machine`
    // above is our own in-process state; `managed_agent_sessions` mirrors a LIVE
    // resource on Anthropic's Managed Agents API, and every transition it ever
    // gets is driven by one source: the webhook at
    // app/api/webhooks/anthropic-agent/route.ts (run_started→running,
    // idled→idle, terminated→terminated).
    //
    // A webhook is not a guarantee. If a delivery is dropped, or the session
    // ends in a way that fires nothing, the row keeps `status='running'` forever
    // — and that stale row is exactly what the admin observability surface
    // reads back (app/api/admin/agents/sessions/route.ts lists running+idle by
    // default), so staff are shown an agent that is still working on a session
    // that finished, with no way to tell the difference.
    //
    // lib/agents/managed-agents-egress.ts:176 `retrieveManagedSession` is the
    // GET against /v1/sessions/{id} written for this and never called. It routes
    // through callConnector, so it never throws and stays healer-observable, and
    // it returns { ok:false, error } when the key is unset rather than pretending.
    //
    // Only STALE non-terminal rows are probed, so a healthy live session costs
    // nothing: a running/idle row whose last_event_at (or created_at, for a
    // session that never got a first event) is older than the threshold. The
    // raw external status is normalized through the ONE boundary mapper
    // (lib/agents/session-status.ts:normalizeManagedSessionStatus) — the sessions
    // API enum is external and an unmapped value would violate
    // managed_agent_sessions_status_check and lose the write.
    const MANAGED_SESSION_STALE_MIN = 60
    const MANAGED_SESSION_PROBE_LIMIT = 25
    const managed = { probed: 0, reconciled: 0, errors: [] as string[] }
    try {
      const staleBefore = new Date(now.getTime() - MANAGED_SESSION_STALE_MIN * 60 * 1000).toISOString()
      const { data: staleSessions, error: staleErr } = await supabase
        .from('managed_agent_sessions')
        .select('id, anthropic_session_id, status, last_event_at, created_at')
        .in('status', ['running', 'idle'])
        .or(`last_event_at.lt.${staleBefore},and(last_event_at.is.null,created_at.lt.${staleBefore})`)
        .order('last_event_at', { ascending: true, nullsFirst: true })
        .limit(MANAGED_SESSION_PROBE_LIMIT)

      if (staleErr) {
        // supabase-js RESOLVES a refused read — say so, never report 0 stale.
        managed.errors.push(`stale managed-session read refused: ${staleErr.message}`)
      } else {
        const { retrieveManagedSession } = await import('@/lib/agents/managed-agents-egress')
        const { normalizeManagedSessionStatus } = await import('@/lib/agents/session-status')

        for (const s of staleSessions ?? []) {
          managed.probed++
          const remote = await retrieveManagedSession(s.anthropic_session_id as string)
          if (!remote.ok) {
            managed.errors.push(`session ${s.id}: ${remote.error ?? 'retrieve failed'}`)
            continue
          }
          const nextStatus = normalizeManagedSessionStatus(remote.status)
          // Only write when the remote actually disagrees. A session that is
          // genuinely still running keeps its row untouched, including its
          // last_event_at — this reconciler must not fake activity.
          if (nextStatus === s.status) continue

          const patch: Record<string, unknown> = {
            status: nextStatus,
            stop_reason: remote.stop_reason ?? null,
          }
          if (nextStatus === 'terminated' || nextStatus === 'error') {
            patch.ended_at = now.toISOString()
          }
          const { error: updErr } = await supabase
            .from('managed_agent_sessions')
            .update(patch)
            .eq('id', s.id as string)
          if (updErr) managed.errors.push(`session ${s.id}: status write refused: ${updErr.message}`)
          else managed.reconciled++
        }
      }
    } catch (err) {
      managed.errors.push(`managed-session reconcile crashed: ${err instanceof Error ? err.message : String(err)}`)
    }
    results.errors.push(...managed.errors)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.checked + managed.probed,
      output_count: results.escalated + managed.reconciled,
      metadata: { ...results, managed_agent_sessions: managed, timestamp: now.toISOString() },
    })

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      ...results,
      managed_agent_sessions: managed,
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
