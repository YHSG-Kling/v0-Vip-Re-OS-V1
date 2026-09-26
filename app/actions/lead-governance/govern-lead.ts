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

    // Every activities row in this function is a GOVERNANCE DECISION — the
    // explanation of a score, a routing choice, an assignment, a promotion
    // signal. A silent loss makes a governed lead indistinguishable from an
    // ungoverned one, which is the exact thing this function exists to prove.
    const { error: scoringActivityError } = await supabase.from('activities').insert({
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
    if (scoringActivityError) {
      console.error(`[LeadGovernance] lead_scoring activity REJECTED for lead ${leadId} — the score has no explanation on the record:`, scoringActivityError.message)
    }

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
        const { error: heldActivityError } = await supabase.from('activities').insert({
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
        if (heldActivityError) {
          console.error(`[LeadGovernance] routing_decision (held) activity REJECTED for lead ${leadId} — a silent non-assignment is exactly what this row exists to prevent:`, heldActivityError.message)
        }
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
        const { error: assignmentActivityError } = await supabase.from('activities').insert({
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
        if (assignmentActivityError) {
          console.error(`[LeadGovernance] agent_assignment activity REJECTED for lead ${leadId} — the lead moved to an agent with no record of why:`, assignmentActivityError.message)
        }

        console.log(`[LeadGovernance] Agent ${agentAssigned} assigned to lead ${leadId}`)
      }
    } else {
      // Log reason for not assigning
      const { error: nurturingActivityError } = await supabase.from('activities').insert({
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
      if (nurturingActivityError) {
        console.error(`[LeadGovernance] routing_decision (nurturing) activity REJECTED for lead ${leadId} — the reason for NOT assigning is unrecorded:`, nurturingActivityError.message)
      }
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
      const { error: promotionActivityError } = await supabase.from('activities').insert({
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
      if (promotionActivityError) {
        console.error(`[LeadGovernance] promotion_signal activity REJECTED for lead ${leadId} — the promotion signal never reaches its reader:`, promotionActivityError.message)
      }

      console.log(`[LeadGovernance] Lead ${leadId} signaled as ready for promotion`)
    }

    return {
      success: true,
      leadId,
      score: scoringResult.finalScore,
      scoreExplanation: scoringResult.explanation,
      routingDecision,
      agentAssigned,
      // THE MERGED THREE-STATE POSTURE (lib/lead-governance/sla-monitor.ts
      // SLAPosture), not the old two-state 'breached'/'compliant'. This field had
      // NO reader anywhere in the tree — the only two callers of governLead
      // (app/dashboard/admin/lead-lineage/lead-lineage-client.tsx:363,376 and
      // lib/ai-isa/qualification-evaluator.ts:117) both read `message` and
      // `agentAssigned` and neither touches `slaStatus` — so widening it breaks
      // nothing and stops the result from hiding the one state that is actionable
      // BEFORE the miss: approaching_sla.
      slaStatus: slaStatus.posture,
      promotionReady: promotionReadiness.ready,
      message: 'Lead governance cycle completed successfully',
    }

  } catch (error: any) {
    console.error(`[LeadGovernance] Error governing lead ${leadId}:`, error.message)

    // Log to automation_errors.
    //
    // TENANT — `brokerageId`, the caller's brokerage, resolved from the session
    // ABOVE the try block, so the catch always holds it: an anchor resolved
    // inside the try is not an anchor a catch can use. This row is the one the
    // automations console reads, and that console does not merely filter by
    // tenant — `app/actions/workflows.ts:531` uses
    // `.eq("brokerage_id", brokerageId)` as an OWNERSHIP CHECK and returns
    // "Forbidden" on a miss, so an unstamped governance failure is not just
    // invisible, it is UNRESOLVABLE: the retry/acknowledge path refuses it
    // forever. (`NULL = <uuid>` is NULL, never true.)
    //
    // `lead_id` is deliberately NOT stamped: the most common way to reach this
    // catch is `Lead ${leadId} not found`, and `automation_errors.lead_id`
    // REFERENCES leads(id) — filing the error would then fail on the very id
    // that caused it.
    const { error: governanceErrorLogError } = await supabase.from('automation_errors').insert({
      brokerage_id: brokerageId,
      workflow_name: 'lead_governance',
      error_message: error.message,
      context_json: JSON.stringify({ leadId }),
      severity: 'high',
      status: 'open',
      created_at: new Date().toISOString(),
    })
    if (governanceErrorLogError) {
      // Named, never swallowed: the ORIGINAL failure is already in `error` and is
      // returned below, so a failure to FILE it cannot be allowed to replace it.
      console.error('[LeadGovernance] automation_errors insert refused:', governanceErrorLogError.message)
    }

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
