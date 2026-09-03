// NOT a server-action module (2026-09-03, integrator, CLAUDE.md §4/§5). The
// module-level 'use server' that stood here made evaluateLeadQualification(leadId)
// a public HTTP endpoint that evaluated and PERSISTED signals for any lead id —
// the tenant came from the lead row, never from the caller. Leads belong to the
// brokerage. The ISA console reaches it through
// app/actions/ai-isa/evaluate-lead-qualification.ts (session tenant pinned on
// the lead first); handle-inbound-email (a gated action) stays in-process.
// `server-only` fails a future client import at build time.
import "server-only"

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

  // Get conversation data.
  //
  // IDENTITY CLASS (lane W3 2026-09-01): `leadId` is a leads.id — proven by the
  // load just above — and `messages.contact_id` FKs contacts(id), a DISJOINT id
  // space. This used to filter messages.contact_id with the leads.id, so the
  // filter matched NOTHING: conversationCount was always 0 and messageText
  // always "", and the ISA's qualification verdict had never seen a single
  // conversation. The crossing is the lead's own `leads.contact_id` — the same
  // join persistQualificationSignals below already reads.
  const linkedContactId = (lead as { contact_id?: string | null }).contact_id ?? null

  let conversationCount = 0
  let messageText = ''
  if (linkedContactId) {
    const { data: messages, error: messagesError } = await supabase
      .from('messages')
      .select('*')
      .eq('contact_id', linkedContactId)
      .order('created_at', { ascending: false })
    if (messagesError) {
      // Say so rather than scoring a refused read as "no conversations".
      console.error('[AI ISA] qualification message read refused:', messagesError.message)
    }
    conversationCount = messages?.length || 0
    messageText = (messages?.slice(0, 5) || []).map(m => m.body).join(' ')
  }
  // else: the lead has NO linked contact yet, so there is no messages row that
  // could belong to it — zero here means "no linked contact", which is honest,
  // and is a different fact from "a contact exists and has no messages".

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
    .select('brokerage_id, first_name, last_name, email, phone, source, lead_score, agent_id, contact_id')
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
      // THE CONTACT SIDE OF THE QUALIFICATION. `contact_id` was read by code and
      // written by nobody (census 1b): app/actions/ai-isa.ts:676 selects it AND
      // embeds `contacts (first_name, last_name)` off it, so the Qualification
      // Outcomes tab listed every outcome with a BLANK NAME, and
      // app/dashboard/isa/page.tsx:259 built its handoff queue off the same
      // embed. A lead that has already been converted carries `leads.contact_id`;
      // one that has not is honestly null (the lead_id side still identifies it).
      contact_id: (lead as { contact_id?: string | null }).contact_id ?? null,
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
  // `scripts/agent-fk-columns.ts` under `USERS_FK_AGENTISH_COLUMNS`
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
      // THE OUTCOME IN WORDS. `notes` was read by code and written by nobody
      // (census 1b) — app/actions/ai-isa.ts:676 renders it as the outcome's
      // explanation column and app/dashboard/admin/lead-lineage/page.tsx:35
      // reads it on the lineage detail, so both showed a permanently empty cell
      // where the reason for the handoff belongs. Everything below is a fact
      // this function already holds: the score, the signals that fired, and
      // Engine 2's own assignment reason. Nothing is generated.
      const notes = [
        `Qualified at ${qualificationScore}/100 after ${signals.conversationCount} exchange${signals.conversationCount === 1 ? '' : 's'}.`,
        `Intent ${signals.confirmedIntent ? 'confirmed' : 'not confirmed'}; urgency ${signals.urgency}; engagement ${signals.engagementLevel}.`,
        assignResult.assigned
          ? `Assigned: ${assignResult.reason ?? 'assignment engine'}.`
          : `Not assigned: ${assignResult.reason ?? 'no eligible agent'}.`,
      ].join(' ')

      // A CONVERTED lead has a contact by now even if it did not at insert time —
      // handleLeadAssigned creates it on the success path — so the contact side
      // is re-read here rather than left null forever on the row the outcomes
      // tab actually renders.
      const { data: leadNow } = await supabase
        .from('leads')
        .select('contact_id')
        .eq('id', leadId)
        .maybeSingle()

      const { error: outcomeErr } = await supabase
        .from('ai_isa_qualifications')
        .update({
          // users.id — see above. `recipient.userId` is null only when the agent
          // row carries no `user_id`, which is the honest "nobody to assign".
          assigned_to_agent_id: recipient.userId,
          assigned_at: assignResult.assigned && recipient.userId ? new Date().toISOString() : null,
          qualified_at: new Date().toISOString(),
          qualification_result: 'qualified',
          contact_id: (leadNow as { contact_id?: string | null } | null)?.contact_id
            ?? (lead as { contact_id?: string | null }).contact_id
            ?? null,
          notes: notes.slice(0, 2000),
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
    // Audit row + reactor (notification_rules keyed on lead_ready_for_assignment now
    // fire; the bare insert reached nothing). Loaded at call time — server-only.
    const { emitKernelEvent } = await import('@/lib/kernel/emit')
    await emitKernelEvent({
      entityType: 'lead',
      entityId: leadId,
      event: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
      brokerageId: lead.brokerage_id,
      metadata: {
        source: 'ai_isa_qualification',
        score: qualificationScore,
        gov_score: govResult?.score,
        assign_reason: assignResult.reason,
      },
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
