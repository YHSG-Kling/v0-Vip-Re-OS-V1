'use server'

/**
 * LEAD GOVERNANCE & SCORING ORCHESTRATOR
 *
 * This is the AUTHORITATIVE DECISION ENGINE for all lead lifecycle decisions.
 *
 * RESPONSIBILITIES:
 * 1. Calculate multi-factor lead score (AUTHORITATIVE)
 * 2. Explain score components
 * 3. Evaluate routing eligibility
 * 4. Select agent (if eligible)
 * 5. Monitor SLA compliance
 * 6. Signal promotion readiness
 * 7. Log all decisions to activities table
 *
 * This system operates on leads ONLY (pre-relationship).
 * Contacts are handled by separate systems.
 *
 * AUTH: previously trusted caller-supplied brokerageId/actorAgentId — any
 * signed-in user could trigger governance on any lead in any brokerage,
 * which could forcibly reassign the lead to a different agent. Now: caller
 * must be authenticated AND the lead's brokerage must match the caller's
 * session brokerage. Cron callers must use the lib-level engine directly.
 */

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  calculateLeadScore,
  evaluateRoutingEligibility,
  evaluateSLA,
  logEscalation,
  evaluatePromotionReadiness,
} from '@/lib/lead-governance'
// The agent PICK comes from the canonical assignment spine, not from a private
// selector. lib/lead-governance/agent-selector.ts used to own it: it never
// queried assignment_rules at all, so the broker's configured method — round
// robin, priorities, ZIP farms, team scoping — was bypassed entirely on this
// path. It sorted candidates by id.localeCompare, took the first, and then
// wrote an activities row claiming selectionMethod 'load_balanced'. Its one real
// idea, filtering by specialization, is now a rule_type the broker can choose.
import { resolveAgentByRules } from '@/lib/lead-assignment/assignment-engine'
import { selectAgentByCapacity, resolveBrokerageMaxLoad } from '@/lib/lead-assignment/capacity-pick'

export interface GovernanceResult {
  success: boolean
  leadId: string
  score: number
  scoreExplanation: string
  routingDecision: 'assign_agent' | 'continue_ai_nurturing' | 'hold_for_review'
  agentAssigned: string | null
  slaStatus: string
  promotionReady: boolean
  message: string
}

/**
 * Execute full governance cycle for a lead
 */
export async function governLead(leadId: string, _brokerageId?: string, _actorAgentId?: string): Promise<GovernanceResult> {
  // Auth gate — was previously trusting caller-supplied identity
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return {
      success: false, leadId, score: 0, scoreExplanation: '',
      routingDecision: 'hold_for_review', agentAssigned: null,
      slaStatus: 'unknown', promotionReady: false, message: 'Unauthorized',
    }
  }
  const { data: callerRow } = await authClient
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) {
    return {
      success: false, leadId, score: 0, scoreExplanation: '',
      routingDecision: 'hold_for_review', agentAssigned: null,
      slaStatus: 'unknown', promotionReady: false, message: 'Unauthorized',
    }
  }
  const brokerageId = callerRow.brokerage_id
  const actorAgentId = user.id

  const supabase = createServiceClient()

  try {
    console.log(`[LeadGovernance] Starting governance cycle for lead ${leadId}`)

    // STEP 1: FETCH LEAD DATA — verify it belongs to caller's brokerage
    const { data: lead, error: fetchError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()

    if (fetchError || !lead) {
      throw new Error(`Lead ${leadId} not found`)
    }

    if (lead.brokerage_id !== brokerageId) {
      throw new Error('Forbidden: lead belongs to a different brokerage')
    }

    // STEP 2: CALCULATE AUTHORITATIVE SCORE
    const scoringResult = calculateLeadScore(lead)
    console.log(`[LeadGovernance] Score calculated: ${scoringResult.finalScore}/100`)

    // STEP 3: UPDATE LEAD WITH SCORE — scoped to caller's brokerage
    await supabase
      .from('leads')
      .update({
        lead_score: scoringResult.finalScore,
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId)
      .eq('brokerage_id', brokerageId)

    // STEP 4: LOG SCORING EXPLANATION — Agent task (correct location, no changes) — activity_type: lead_scoring, agent_assignment, routing_decision, promotion_signal
    let agentAssigned: string | null = null

    await supabase.from('activities').insert({
      activity_type: 'lead_scoring',
      title: `Lead Scored: ${scoringResult.finalScore}/100`,
      description: scoringResult.explanation,
      status: 'completed',
      priority: 'normal',
      notes: JSON.stringify(scoringResult.factors),
      brokerage_id: lead.brokerage_id || brokerageId,
      agent_id: agentAssigned || actorAgentId || lead.agent_id,
      entity_type: 'lead',
      created_at: new Date().toISOString(),
    })

    // STEP 5: EVALUATE ROUTING ELIGIBILITY
    const routingEligibility = await evaluateRoutingEligibility(
      lead,
      scoringResult.finalScore,
      lead.brokerage_id,
      supabase
    )

    const routingDecision = routingEligibility.eligible ? 'assign_agent' : 'continue_ai_nurturing'
    console.log(`[LeadGovernance] Routing decision: ${routingDecision}`)

    // STEP 6: ASSIGN AGENT IF ELIGIBLE
    if (routingEligibility.eligible) {
      // The broker's own assignment rules decide, through the same resolver
      // Engine 2 uses — priorities, team scoping, and the chosen method (round
      // robin / load balance / geographic / expertise / manual).
      const ruled = await resolveAgentByRules(supabase, lead.brokerage_id, lead)

      // No rule matched: fall back to the capacity-aware balancer rather than
      // stranding the lead. This is the SAME picker the Capacity Guardian uses,
      // so a lead never lands on an agent already over their ceiling.
      let selectedAgentId = ruled.agentId
      let selectionReason = ruled.method
        ? `Assigned by rule via ${ruled.method}.`
        : ''
      if (!ruled.held && !selectedAgentId) {
        const { data: actives } = await supabase
          .from('agents')
          .select('id')
          .eq('brokerage_id', lead.brokerage_id)
          .eq('is_active', true)
        const pool = (actives ?? []).map((a: { id: string }) => a.id)
        if (pool.length > 0) {
          const maxLoad = await resolveBrokerageMaxLoad(supabase, lead.brokerage_id)
          selectedAgentId = await selectAgentByCapacity(supabase, lead.brokerage_id, pool, maxLoad)
          selectionReason = `No rule matched — assigned to the agent with the most headroom (of ${pool.length} active).`
        }
      }

      if (ruled.held) {
        // A manual rule matched: the broker asked for this lead to wait for a
        // person. Recording it is the point — a silent non-assignment is
        // indistinguishable from a broken router.
        await supabase.from('activities').insert({
          activity_type: 'routing_decision',
          title: 'Held for Manual Assignment',
          description: ruled.reason ?? 'A manual assignment rule matched this lead.',
          status: 'completed',
          priority: 'normal',
          agent_id: actorAgentId || lead.agent_id,
          brokerage_id: lead.brokerage_id || brokerageId,
          entity_type: 'lead',
          created_at: new Date().toISOString(),
        })
        console.log(`[LeadGovernance] Lead ${leadId} held for manual assignment`)
      } else if (selectedAgentId) {
        await supabase
          .from('leads')
          .update({
            agent_id: selectedAgentId,
            lead_stage: 'assigned',
            stage_entered_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', leadId)
          .eq('brokerage_id', brokerageId)

        agentAssigned = selectedAgentId

        // The description records what ACTUALLY decided. The retired selector
        // wrote "using load balancing" for a pick made by sorting on id.
        await supabase.from('activities').insert({
          activity_type: 'agent_assignment',
          title: 'Agent Assigned via Governance',
          description: selectionReason,
          status: 'completed',
          priority: 'normal',
          agent_id: agentAssigned || actorAgentId || lead.agent_id,
          brokerage_id: lead.brokerage_id || brokerageId,
          entity_type: 'lead',
          created_at: new Date().toISOString(),
        })

        console.log(`[LeadGovernance] Agent ${agentAssigned} assigned to lead ${leadId}`)
      }
    } else {
      // Log reason for not assigning
      await supabase.from('activities').insert({
        activity_type: 'routing_decision',
        title: 'Lead Held in AI Nurturing',
        description: routingEligibility.reason,
        status: 'completed',
        priority: 'normal',
        notes: JSON.stringify(routingEligibility.thresholdsMet),
        brokerage_id: lead.brokerage_id || brokerageId,
        agent_id: agentAssigned || actorAgentId || lead.agent_id,
        entity_type: 'lead',
        created_at: new Date().toISOString(),
      })
    }

    // STEP 7: SLA MONITORING
    const slaStatus = evaluateSLA(lead)
    
    if (slaStatus.escalationRequired) {
      await logEscalation(leadId, slaStatus, supabase)
      console.log(`[LeadGovernance] SLA breach detected and escalated for lead ${leadId}`)
    }

    // STEP 8: EVALUATE PROMOTION READINESS
    const promotionReadiness = evaluatePromotionReadiness(lead)
    
    if (promotionReadiness.ready) {
      await supabase.from('activities').insert({
        activity_type: 'promotion_signal',
        title: 'Lead Ready for Contact Promotion',
        description: promotionReadiness.reason,
        status: 'pending',
        priority: 'high',
        brokerage_id: lead.brokerage_id || brokerageId,
        agent_id: agentAssigned || actorAgentId || lead.agent_id,
        entity_type: 'lead',
        created_at: new Date().toISOString(),
      })

      console.log(`[LeadGovernance] Lead ${leadId} signaled as ready for promotion`)
    }

    return {
      success: true,
      leadId,
      score: scoringResult.finalScore,
      scoreExplanation: scoringResult.explanation,
      routingDecision,
      agentAssigned,
      slaStatus: slaStatus.isBreached ? 'breached' : 'compliant',
      promotionReady: promotionReadiness.ready,
      message: 'Lead governance cycle completed successfully',
    }

  } catch (error: any) {
    console.error(`[LeadGovernance] Error governing lead ${leadId}:`, error.message)

    // Log to automation_errors
    await supabase.from('automation_errors').insert({
      workflow_name: 'lead_governance',
      error_message: error.message,
      context_json: JSON.stringify({ leadId }),
      severity: 'high',
      status: 'open',
      created_at: new Date().toISOString(),
    })

    return {
      success: false,
      leadId,
      score: 0,
      scoreExplanation: '',
      routingDecision: 'hold_for_review',
      agentAssigned: null,
      slaStatus: 'unknown',
      promotionReady: false,
      message: `Governance failed: ${error.message}`,
    }
  }
}
