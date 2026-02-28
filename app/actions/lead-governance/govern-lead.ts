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
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  calculateLeadScore,
  evaluateRoutingEligibility,
  selectAgentForLead,
  evaluateSLA,
  logEscalation,
  evaluatePromotionReadiness,
} from '@/lib/lead-governance'

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
export async function governLead(leadId: string): Promise<GovernanceResult> {
  const supabase = createServiceClient()

  try {
    console.log(`[v0] [LEAD GOVERNANCE] Starting governance cycle for lead ${leadId}`)

    // STEP 1: FETCH LEAD DATA
    const { data: lead, error: fetchError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()

    if (fetchError || !lead) {
      throw new Error(`Lead ${leadId} not found`)
    }

    // STEP 2: CALCULATE AUTHORITATIVE SCORE
    const scoringResult = calculateLeadScore(lead)
    console.log(`[LeadGovernance] Score calculated: ${scoringResult.finalScore}/100`)

    // STEP 3: UPDATE LEAD WITH SCORE
    await supabase
      .from('leads')
      .update({
        lead_score: scoringResult.finalScore,
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId)

    // STEP 4: LOG SCORING EXPLANATION — Agent task (correct location, no changes) — activity_type: lead_scoring, agent_assignment, routing_decision, promotion_signal
    await supabase.from('activities').insert({
      activity_type: 'lead_scoring',
      title: `Lead Scored: ${scoringResult.finalScore}/100`,
      description: scoringResult.explanation,
      status: 'completed',
      priority: 'normal',
      notes: JSON.stringify(scoringResult.factors),
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

    let agentAssigned: string | null = null

    // STEP 6: ASSIGN AGENT IF ELIGIBLE
    if (routingEligibility.eligible) {
      const agentSelection = await selectAgentForLead(lead, lead.brokerage_id)
      
      if (agentSelection.selectedAgentId) {
        await supabase
          .from('leads')
          .update({
            agent_id: agentSelection.selectedAgentId,
            lead_stage: 'assigned',
            stage_entered_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', leadId)

        agentAssigned = agentSelection.selectedAgentId

        // Log assignment decision
        await supabase.from('activities').insert({
          activity_type: 'agent_assignment',
          title: 'Agent Assigned via Governance',
          description: agentSelection.reason,
          status: 'completed',
          priority: 'normal',
          agent_id: agentSelection.selectedAgentId,
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
    console.error(`[v0] [LEAD GOVERNANCE] Error governing lead ${leadId}:`, error.message)

    // Log to automation_errors
    await supabase.from('automation_errors').insert({
      workflow_name: 'lead_governance',
      error_message: error.message,
      context_json: JSON.stringify({ leadId }),
      severity: 'high',
      status: 'unresolved',
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
