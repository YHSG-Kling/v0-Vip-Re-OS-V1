import { NextRequest, NextResponse } from 'next/server'
import { 
  routeToAgent, 
  escalateToHuman, 
  endAgentSession,
  clearHumanOverride,
  getActiveSession,
} from '@/lib/intelligence/multi-agent-router'
import type { AgentCapability } from '@/lib/intelligence/agent-registry'

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/intelligence/coordinate
// Internal API for agent coordination. Protected by INTERNAL_API_SECRET.
// ══════════════════════════════════════════════════════════════════════════════

export async function POST(request: NextRequest) {
  // Verify internal API secret — FAIL CLOSED when unset (CLAUDE.md §4). The old
  // comparison interpolated the env var into the template, so an unset secret
  // produced the literal expected value "Bearer undefined", which any caller
  // could type. A gate that cannot run must refuse, not pass.
  const expectedSecret = process.env.INTERNAL_API_SECRET
  const authHeader = request.headers.get('authorization')
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  const body = await request.json()
  const { action } = body
  
  switch (action) {
    case 'route': {
      const { entityType, entityId, brokerageId, agentId, capability, context, priority } = body
      
      if (!entityType || !entityId || !brokerageId || !capability) {
        return NextResponse.json(
          { error: 'Missing required fields: entityType, entityId, brokerageId, capability' },
          { status: 400 }
        )
      }
      
      const result = await routeToAgent({
        entityType,
        entityId,
        brokerageId,
        agentId,
        capability: capability as AgentCapability,
        context,
        priority,
      })
      
      return NextResponse.json(result)
    }
    
    case 'escalate': {
      const { sessionId, reason, urgency, suggestedAction } = body
      
      if (!sessionId || !reason || !urgency) {
        return NextResponse.json(
          { error: 'Missing required fields: sessionId, reason, urgency' },
          { status: 400 }
        )
      }
      
      const result = await escalateToHuman({
        sessionId,
        reason,
        urgency,
        suggestedAction,
      })
      
      return NextResponse.json(result)
    }
    
    case 'end': {
      const { sessionId, outcome, summary } = body
      
      if (!sessionId || !outcome) {
        return NextResponse.json(
          { error: 'Missing required fields: sessionId, outcome' },
          { status: 400 }
        )
      }
      
      const result = await endAgentSession({
        sessionId,
        outcome,
        summary,
      })
      
      return NextResponse.json(result)
    }
    
    case 'clearOverride': {
      const { entityType, entityId } = body
      
      if (!entityType || !entityId) {
        return NextResponse.json(
          { error: 'Missing required fields: entityType, entityId' },
          { status: 400 }
        )
      }
      
      const result = await clearHumanOverride({ entityType, entityId })
      return NextResponse.json(result)
    }
    
    case 'getSession': {
      const { entityType, entityId } = body
      
      if (!entityType || !entityId) {
        return NextResponse.json(
          { error: 'Missing required fields: entityType, entityId' },
          { status: 400 }
        )
      }
      
      const result = await getActiveSession({ entityType, entityId })
      return NextResponse.json(result)
    }
    
    default:
      return NextResponse.json(
        { error: `Unknown action: ${action}. Valid actions: route, escalate, end, clearOverride, getSession` },
        { status: 400 }
      )
  }
}
