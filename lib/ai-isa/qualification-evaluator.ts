'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import {
  deriveQualificationSignals,
  qualificationScoreFor,
  type QualificationSignals,
} from './qualification-core'

export type { QualificationSignals } from './qualification-core'

export async function evaluateLeadQualification(leadId: string): Promise<QualificationSignals> {
  const supabase = createServiceClient()

  // Get lead data
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (!lead) {
    throw new Error(`Lead not found: ${leadId}`)
  }

  // Get conversation data
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('contact_id', leadId)
    .order('created_at', { ascending: false })

  const conversationCount = messages?.length || 0
  const recentMessages = messages?.slice(0, 5) || []
  const messageText = recentMessages.map(m => m.body).join(' ')

  // Decision logic lives in qualification-core (shared with the ISA conversation
  // tool + regression simulator) — this function owns only the DB loading.
  return deriveQualificationSignals({
    messageText,
    conversationCount,
    timeline: lead.timeline,
    leadScore: lead.lead_score,
  })
}

export async function persistQualificationSignals(
  leadId: string,
  signals: QualificationSignals
) {
  const supabase = createServiceClient()

  // Step 1: Persist qualification record with current signals
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('brokerage_id, first_name, last_name, email, phone, source, lead_score, agent_id')
    .eq('id', leadId)
    .single()

  if (leadError || !lead) {
    console.error('[AI ISA] persistQualificationSignals: lead not found', leadId)
    return
  }

  const qualificationScore = qualificationScoreFor(signals)

  // Insert qualification record
  const { data: qualRecord } = await supabase
    .from('ai_isa_qualifications')
    .insert({
      lead_id: leadId,
      brokerage_id: lead.brokerage_id,
      qualification_score: qualificationScore,
      stage: signals.readinessForAgent ? 'qualified' : signals.confirmedIntent ? 'in_progress' : 'initial',
      // CHECK enum: qualified | not_qualified | needs_follow_up | appointment_set | no_response
      // "pending" is not a valid value — needs_follow_up matches the AI-still-working semantic.
      qualification_result: signals.readinessForAgent ? 'qualified' : 'needs_follow_up',
      qualification_signals: signals as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()

  // If NOT ready for agent, stop here — AI-ISA continues working this lead
  if (!signals.readinessForAgent) {
    return
  }

  // ── FULL HANDOFF CHAIN (readinessForAgent = true) ────────────────────────

  // Step 2: Transition lifecycle via the OFFICIAL handler chain.
  //         lead-acquisition-handlers.ts is the SOLE writer of lifecycle_state.
  //         handleConsentReceived: isa_qualifying → consented (valid transition)
  //         This also stamps stage_entered_at and fires CONSENT_RECEIVED event.
  const { handleConsentReceived } = await import('@/lib/kernel/lead-acquisition-handlers')
  await handleConsentReceived({
    leadId,
    brokerageId: lead.brokerage_id,
    consentSource: 'reply',
  })

  // Step 3: Mark the lead as qualified — this satisfies Engine 2's gate
  //         (lead_stage = 'qualified' AND lifecycle_state = 'consented').
  //         Engine 2 (assignment-engine.evaluateAndAssignLead) is the SOLE
  //         agent-assignment path going forward — governLead is now scoring-only.
  await supabase
    .from('leads')
    .update({
      lead_stage: 'qualified',
      ai_isa_owner: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  // Step 4: Score the lead (governLead in scoring-only mode keeps the score
  //         current for Engine 2's rule conditions like min_score).
  const { governLead } = await import('@/app/actions/lead-governance/govern-lead')
  const govResult = await governLead(leadId, lead.brokerage_id)

  // Step 5: Engine 2 — Qualification-Triggered Assignment
  //         Reads brokerage assignment_rules and selects an agent.
  const { evaluateAndAssignLead } = await import('@/lib/lead-assignment/assignment-engine')
  const assignResult = await evaluateAndAssignLead({
    leadId,
    brokerageId: lead.brokerage_id,
  })

  // Step 6: Update qualification record with the outcome.
  //
  // ── THE ID SPACE, AND WHY THIS UPDATE HAS BEEN REFUSED ────────────────────
  //
  // `ai_isa_qualifications.assigned_to_agent_id` FKs **users(id)**, not
  // agents(id) — verified against the live catalogue, and already recorded in
  // `scripts/agent-fk-columns.ts:258` under `USERS_FK_AGENTISH_COLUMNS`
  // ("columns that FK public.users(id) but whose NAME reads agent-ish"). The
  // reader agrees: `app/actions/ai-isa.ts:528` embeds
  // `assigned_agent:users!assigned_to_agent_id (…)`.
  //
  // `evaluateAndAssignLead` returns an **agents.id** in every branch — the rule
  // pool is built from `agents` (`assignment-engine.ts:104`), the capacity pick
  // reads `agents`, and `resolveSoloAgentOwner` returns `agents.id`. The two
  // spaces are DISJOINT (measured live: zero overlap), so writing it straight in
  // is a 23503 foreign-key violation — and supabase-js RESOLVES a refused query,
  // so with no `error` destructured this whole update silently did nothing:
  // `assigned_at`, `qualified_at` and `qualification_result` were lost with it.
  // The handoff queue reads `.is("assigned_to_agent_id", null)`, so the lead sat
  // in the queue as unassigned after Engine 2 had assigned it.
  //
  // Crossed with the resolver wave 23 added for exactly this, rather than a
  // second private copy of `select user_id from agents`.
  if (qualRecord?.id) {
    const { resolveAgentRecipient } = await import('@/lib/notifications/recipient-tenant')
    const recipient = await resolveAgentRecipient(supabase, assignResult.agentId)
    if (!recipient.ok) {
      // A REFUSAL is not "this agent has no user". Fail loudly rather than
      // writing null over a real assignment.
      console.error('[AI ISA] could not resolve the assigned agent to a user:', recipient.reason)
    } else {
      if (assignResult.agentId && !recipient.userId) {
        console.error(
          '[AI ISA] assigned agent has no linked users row; recording the qualification without an assignee:',
          assignResult.agentId,
        )
      }
      const { error: outcomeErr } = await supabase
        .from('ai_isa_qualifications')
        .update({
          // users.id — see above. `recipient.userId` is null only when the agent
          // row carries no `user_id`, which is the honest "nobody to assign".
          assigned_to_agent_id: recipient.userId,
          assigned_at: assignResult.assigned && recipient.userId ? new Date().toISOString() : null,
          qualified_at: new Date().toISOString(),
          qualification_result: 'qualified',
        })
        .eq('id', qualRecord.id)
      if (outcomeErr) {
        console.error('[AI ISA] failed to record the qualification outcome:', outcomeErr.message)
      }
    }
  }

  // Step 7: If Engine 2 couldn't find an agent, the qualified+consented lead would
  //         otherwise sit ownerless and invisible until the stale detector noticed
  //         days later. Record the audit event AND ESCALATE to the broker/admins (or
  //         platform if the brokerage has none) so a human activates an agent / fixes
  //         the rules before the hot lead goes cold. handleLeadAssigned already handles
  //         the success path (lifecycle transition + contact creation + notification).
  if (!assignResult.assigned) {
    await supabase.from('lifecycle_events').insert({
      entity_type: 'lead',
      entity_id: leadId,
      event_type: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
      brokerage_id: lead.brokerage_id,
      metadata: {
        source: 'ai_isa_qualification',
        score: qualificationScore,
        gov_score: govResult?.score,
        assign_reason: assignResult.reason,
      },
      created_at: new Date().toISOString(),
    })

    const { escalateUnassignedQualifiedLead } = await import('@/lib/lead-assignment/unassigned-escalation')
    await escalateUnassignedQualifiedLead(supabase, {
      leadId,
      brokerageId: lead.brokerage_id,
      reason: assignResult.reason,
      score: qualificationScore,
    })
  }
}
