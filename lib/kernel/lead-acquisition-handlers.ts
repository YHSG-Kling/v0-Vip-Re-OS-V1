// SYSTEM: Kernel Lead-Acquisition Handlers (Track A — Lead-first)
// FILE: lib/kernel/lead-acquisition-handlers.ts
// TRACK: Scraped/Raw pipeline only. Forms/QR/Card/Imports use captureContact()
//   in lib/contact-pipeline/contact-capture.ts (Build 05).
// RULE: createServiceClient() is SYNC — never await it.
// RULE: No string literals for events. Always use KernelEvent.X enum values.
// RULE: context_json in automation_errors is TEXT — always JSON.stringify().
// RULE: Only this file writes leads.lifecycle_state. No other file may do so.

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { calculateLeadScore, evaluateRoutingEligibility } from "@/lib/lead-governance/index"

// ─── VALID TRANSITIONS ────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  raw:            ['unconsented'],
  unconsented:    ['isa_qualifying'],
  isa_qualifying: ['consented'],
  consented:      ['assigned'],
  assigned:       ['appointment'],
  appointment:    ['representation'],
  representation: [],
}

// ─── TRANSITION GUARD ────────────────────────────────────────────────────────
export async function assertValidTransition(
  current: string,
  next: string,
  leadId: string
): Promise<void> {
  if (!(ALLOWED_TRANSITIONS[current] ?? []).includes(next)) {
    const supabase = createServiceClient()
    // TENANT — the LEAD this illegal transition was attempted on. This site was
    // stamping `brokerage_id: null` EXPLICITLY, which is why no census of
    // "unstamped writers" ever saw it: at depth 1 the key was present and the
    // value was the problem. An illegal lifecycle transition is a single
    // brokerage's lead going wrong, not a platform event, so it belongs in that
    // brokerage's automations console — where `workflows.ts:531` reads
    // `.eq("brokerage_id", …)` as an ownership check and refuses "Forbidden" on
    // anything it cannot match.
    //
    // `error` is destructured, and the throw below happens either way: nothing
    // about resolving the tenant is allowed to swallow the transition failure
    // this function exists to raise.
    const { data: guardLead, error: guardLeadError } = await supabase
      .from('leads')
      .select('brokerage_id')
      .eq('id', leadId)
      .maybeSingle()
    if (guardLeadError) {
      console.error('[lead-acquisition-handlers] transition guard: leads lookup refused:', guardLeadError.message)
    }
    const guardBrokerageId = ((guardLead as { brokerage_id: string | null } | null)?.brokerage_id as string | null) ?? null
    if (!guardBrokerageId) {
      console.error(
        `[lead-acquisition-handlers] no brokerage resolves for lead ${leadId} — illegal-transition row NOT written rather than written where the console can neither see nor resolve it`,
      )
    } else {
      const { error: guardLogError } = await supabase.from('automation_errors').insert({
        workflow_name: 'lifecycle_transition_guard',
        error_message: `Illegal transition: ${current} → ${next} on lead ${leadId}`,
        context_json: JSON.stringify({ leadId, current, next }),
        brokerage_id: guardBrokerageId,
        severity: 'error',
        status: 'open',
      })
      if (guardLogError) {
        console.error('[lead-acquisition-handlers] automation_errors insert refused:', guardLogError.message)
      }
    }
    throw new Error(`Illegal lifecycle transition: ${current} → ${next}`)
  }
}

// ─── HANDLER 1: handleLeadCaptured ───────────────────────────────────────────
export async function handleLeadCaptured(params: {
  leadId: string
  brokerageId: string
  actorUserId?: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  await assertValidTransition('raw', 'unconsented', leadId)

  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'unconsented',
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_CAPTURED,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  // ── LEAD ENRICHMENT (wave 5) ───────────────────────────────────────────────
  // This used to be a bare INSERT into lead_enrichment_queue right here:
  //
  //   await supabase.from('lead_enrichment_queue').insert({
  //     lead_id: leadId, brokerage_id: brokerageId, status: 'pending',
  //     enrichment_type: 'skip_trace', trigger_type: 'lead_captured', queued_at,
  //   })
  //
  // It carried NONE of the guards the contact lane spent wave 3 consolidating:
  // no freshness check (a lead captured twice paid twice), no pending-row
  // idempotency, no identifier gate (a scraped row with no name, email or phone
  // bought a guaranteed PeopleData miss and then burned its three retries against
  // the drain's own identifier refusal), no live-deal suppression, no vendor
  // budget pre-flight, no backlog cap.
  //
  // MERGED, not deleted: the capability — "a captured lead gets enriched" — is
  // exactly what the survivor does, and it does it with every guard.
  // Survivor: lib/enrichment/lead-enrichment-core.ts:queueLeadEnrichment.
  //
  // Awaited (not voided) because this handler is already the async lifecycle
  // path and the writer never throws; the SLA row below must still be written
  // whatever the queue decides.
  try {
    const { queueLeadEnrichment } = await import('@/lib/enrichment/lead-enrichment-core')
    await queueLeadEnrichment({
      leadId,
      brokerageId,
      triggerType: 'lead_captured',
      supabase,
    })
  } catch (err) {
    console.error('[lead-acquisition] lead enrichment enqueue failed:', err)
  }

  const targetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('lead_sla_tracking').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    sla_type: 'first_contact',
    target_at: targetAt,
    breached: false,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_CAPTURED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  // Wave 38 CORRECTION: lead-stage FB audience push REMOVED. Per Meta's
  // Custom Audiences policy, recipients must be consented; leads on this
  // platform are explicitly unconsented (lifecycle_state='unconsented' at
  // capture time). The audience push happens in handleLeadAssigned (where
  // the lead has converted to a CONTACT with tcpa_consent verified before
  // staging).

  // Content channel — auto-enroll the captured lead into the brokerage/team/solo newsletter
  // (CAN-SPAM email, unlike the consent-gated FB push): the passive "stay top of mind" tool
  // fires from lead capture, not just manual signup. Verified email + not opted out only;
  // never re-subscribes an unsubscribed email. Best-effort, non-blocking.
  try {
    const { enrollLeadInNewsletter } = await import('@/lib/content/newsletter-enrollment')
    void enrollLeadInNewsletter({ leadId, brokerageId })
      .catch((e) => console.error('[lead-acquisition] lead newsletter enroll failed:', e))
  } catch { /* best-effort */ }
}

// ─── HANDLER 2: handleLeadScored ─────────────────────────────────────────────
export async function handleLeadScored(params: {
  leadId: string
  brokerageId: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (fetchError || !lead) {
    throw new Error(`handleLeadScored: lead not found: ${leadId}`)
  }

  const result = calculateLeadScore(lead)

  const urgencyLevel: string =
    result.finalScore >= 75 ? 'hot'
    : result.finalScore >= 50 ? 'warm'
    : result.finalScore >= 25 ? 'cool'
    : 'cold'

  await supabase
    .from('leads')
    .update({
      lead_score: result.finalScore,
      urgency_level: urgencyLevel,
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lead_score_history').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    score: result.finalScore,
    scoring_factors: result.factors,
    explanation: result.explanation,
    urgency_level: urgencyLevel,
    scored_at: new Date().toISOString(),
  })

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_SCORED,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_SCORED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  await handleISAQualificationStarted({ leadId, brokerageId })
}

// ─── HANDLER 3: handleISAQualificationStarted ────────────────────────────────
export async function handleISAQualificationStarted(params: {
  leadId: string
  brokerageId: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (fetchError || !lead) {
    throw new Error(`handleISAQualificationStarted: lead not found: ${leadId}`)
  }

  await evaluateRoutingEligibility(lead, lead.lead_score ?? 0, brokerageId, supabase)

  await assertValidTransition('unconsented', 'isa_qualifying', leadId)

  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'isa_qualifying',
      stage_entered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  const targetAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  await supabase.from('lead_sla_tracking').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    sla_type: 'qualification',
    target_at: targetAt,
    breached: false,
    created_at: new Date().toISOString(),
  })

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.ISA_QUALIFICATION_STARTED,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.ISA_QUALIFICATION_STARTED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })
}

// ─── HANDLER 4: handleConsentReceived ────────────────────────────────────────
// ONLY called for lead-first track. NEVER for business cards, imports, or scraped.
// Forms and QR set tcpa_consent=true directly via captureContact() in Build 05.
export async function handleConsentReceived(params: {
  leadId: string
  brokerageId: string
  consentSource: 'form' | 'qr' | 'reply'
}): Promise<void> {
  const { leadId, brokerageId, consentSource } = params
  const supabase = createServiceClient()

  await assertValidTransition('isa_qualifying', 'consented', leadId)

  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'consented',
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.CONSENT_RECEIVED,
    brokerage_id: brokerageId,
    metadata: { consentSource },
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.CONSENT_RECEIVED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  await handleLeadReadyForAssignment({ leadId, brokerageId })
}

// ─── HANDLER 5: handleLeadReadyForAssignment ─────────────────────────────────
export async function handleLeadReadyForAssignment(params: {
  leadId: string
  brokerageId: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })
}

// ─── HANDLER 6: handleLeadAssigned ───────────────────────────────────────────
// AUTO-CREATES contact on assignment.
// tcpa_consent = TRUE only for 'web_form' and 'qr_scan' sources.
export async function handleLeadAssigned(params: {
  leadId: string
  brokerageId: string
  agentId: string
  ruleId?: string
  method: string
  scoreAtAssignment: number
}): Promise<void> {
  const { leadId, brokerageId, agentId, ruleId, method, scoreAtAssignment } = params
  const supabase = createServiceClient()

  await assertValidTransition('consented', 'assigned', leadId)

  const { data: agentRow, error: agentError } = await supabase
    .from('agents')
    .select('user_id')
    .eq('id', agentId)
    .single()

  if (agentError || !agentRow) {
    throw new Error(`handleLeadAssigned: agent not found: ${agentId}`)
  }
  const agentUserId: string = agentRow.user_id

  // Full row — the canonical converter (createContactFromLead) is LOSSLESS and
  // needs the complete field set (address/mailing breakdown, secondary phone,
  // enrichment profile, consent provenance), not a hand-picked subset.
  const { data: leadData, error: leadError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (leadError || !leadData) {
    throw new Error(`handleLeadAssigned: lead not found: ${leadId}`)
  }

  // Cast — newer columns aren't in the generated Supabase types yet; the canonical
  // converter consumes the whole row.
  const lead = leadData as Record<string, any>

  // `handed_to_agent_at` — WHEN the brokerage's lead became an agent's. Until now
  // only the two MANUAL paths stamped it (app/actions/leads.ts:223 and :357), so
  // every lead routed by this AUTOMATIC lane — which is the lane the owner's ruling
  // makes the normal one — reached an agent with the column still null, and the
  // lead-lineage console (app/dashboard/admin/lead-lineage) rendered "Handed at: —"
  // for exactly the assignments it exists to audit.
  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'assigned',
      agent_id: agentId,
      handed_to_agent_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('assignment_log').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    agent_id: agentId,
    rule_id: ruleId ?? null,
    assignment_method: method,
    score_at_assignment: Math.round(scoreAtAssignment),
    created_at: new Date().toISOString(),
  })

  await supabase
    .from('lead_sla_tracking')
    .update({ completed_at: new Date().toISOString() })
    .eq('lead_id', leadId)
    .eq('sla_type', 'assignment')
    .is('completed_at', null)

  // ASSIGNMENT ATTRIBUTION (round 38): the LEAD_ASSIGNED event itself carries
  // WHICH policy routed the lead (matched rule + method + agent) — the same
  // attribution assignment_log records, mirrored onto the kernel event so the
  // event stream is self-describing. The assignment-policy outcomes rail
  // (lib/analytics/assignment-outcomes.ts) grades policies off assignment_log.
  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_ASSIGNED,
    brokerage_id: brokerageId,
    metadata: { assignment: { rule_id: ruleId ?? null, method, agent_id: agentId } },
    created_at: new Date().toISOString(),
  })

  // Convert lead → contact through THE canonical, lossless converter (Data Steward
  // owned — lib/contact-promotion/contact-creator.ts). This replaced a second,
  // hand-rolled insert here that (a) wrote agentUserId (users.id) into
  // contacts.agent_id — which is agents.id by contract, so every converted contact
  // was INVISIBLE to the assigned agent's CRM via RLS — and (b) dropped the
  // address/mailing breakdown, secondary phone, and the whole enrichment profile.
  const { createContactFromLead, motivationToContactType } =
    await import('@/lib/contact-promotion/contact-creator')
  const conversion = await createContactFromLead(supabase, {
    leadId,
    lead,
    agentId, // agents.id — the converter's documented contract
    brokerageId,
  })

  if (conversion.error || !conversion.contactId) {
    throw new Error(`handleLeadAssigned: failed to create contact: ${conversion.error ?? 'no data'}`)
  }
  const contact = { id: conversion.contactId }
  const contactType =
    motivationToContactType(lead.motivation_type) ??
    motivationToContactType(lead.lead_type) ??
    null

  // ── THE LINEAGE LINK **AND** THE HISTORY CARRY ────────────────────────────
  //
  // This used to be a bare inline UPDATE stamping `contact_id` + `converted_at`
  // and nothing else. That is HALF of what a conversion owes the new contact,
  // and the missing half was the half nobody could see:
  //
  //   · the LINK (leads.contact_id + converted_at) makes the `contact_lead_history`
  //     view (migration 039) return lineage. The inline update did that much.
  //   · the RE-POINT — filling `contact_id` on the SIXTEEN tables that carry BOTH
  //     `lead_id` and `contact_id` (ai_isa_activities, ai_isa_calls,
  //     ai_isa_qualifications, voice_calls, isa_outreach_log, contact_consent_events,
  //     chat_sessions, …) — is what makes the ISA history sheet, the contact detail
  //     pane and conversation memory show the lead-phase conversation. NOTHING here
  //     did that.
  //
  // `carryLeadHistoryToContact` (lib/contact-promotion/history-carry.ts) performs
  // both, and it was wired into the MANUAL lane only (promoteLeadToContactService
  // step 5b). This — handleLeadAssigned — is the AUTOMATIC lane, the one the owner's
  // routing ruling makes the NORMAL path: a qualified lead that clears
  // evaluateAndAssignLead becomes a contact here with no human click. So every
  // automatically-converted contact opened onto an EMPTY history while the lead's
  // own calls, qualification and consent trail sat unreachable behind a `leads` row
  // migration 034 locks agents out of. The two lanes now run the SAME function —
  // not a second copy, which is exactly how the two drifted in the first place.
  //
  // Best-effort by construction: every step inside destructures its own `{ error }`
  // and reports it as a warning. A history-carry failure must never turn a
  // successful assignment+conversion into a thrown request.
  {
    const { carryLeadHistoryToContact } = await import('@/lib/contact-promotion/history-carry')
    const carry = await carryLeadHistoryToContact(supabase, {
      leadId,
      contactId: contact.id,
      brokerageId,
    })
    for (const w of carry.warnings) {
      console.error(`[lead-acquisition] history carry: ${w}`)
    }
    if (Object.keys(carry.repointed).length > 0) {
      console.log(`[lead-acquisition] history re-pointed to contact ${contact.id}:`, carry.repointed)
    }
    // MOVED is logged separately from RE-POINTED on purpose: a move RELEASES the
    // lead_id, so it is the only half of the carry that changes what the lead-side
    // read returns. Folding the two counts together would hide that.
    if (Object.keys(carry.moved).length > 0) {
      console.log(`[lead-acquisition] history moved to contact ${contact.id} (lead released):`, carry.moved)
    }

    // DEACTIVATION — delegated, not re-implemented. This used to be an inline
    // `is_active: false` update and nothing else, which left TWO of the four
    // conversion markers unwritten on this lane: `ai_isa_owner` stayed true (so
    // the ISA still considered the lead its own) and any `sequence_enrollments`
    // stayed 'active'/'paused' (so a campaign step could still fire at a person
    // who is now a contact). All three converters now call the ONE deactivation
    // implementation — lib/contact-promotion/lead-deactivator.ts — so they can
    // no longer drift apart (CLAUDE.md §6). It writes only lead-CLOSURE columns;
    // `lifecycle_state`, which this file owns, is untouched by it.
    const { deactivateLead } = await import('@/lib/contact-promotion/lead-deactivator')
    const deactivated = await deactivateLead(supabase, leadId)
    if (!deactivated.success) {
      console.error(
        `[lead-acquisition] lead ${leadId} converted to contact ${contact.id} but was NOT deactivated: ${deactivated.error ?? 'unknown error'}`,
      )
    }

    // THE AGENT ACTION PLAN — WIRED HERE FOR EXACTLY THE REASON THE HISTORY CARRY
    // ABOVE IS. The plan's writer was built onto the MANUAL lane
    // (promote-lead-to-contact.ts step 9) and this — handleLeadAssigned — is the
    // AUTOMATIC lane, the one the owner's routing ruling makes the NORMAL path.
    // Leaving it on one lane is how `carryLeadHistoryToContact` came to be wired
    // into the manual lane only, which is the defect recorded a few lines above.
    // Both lanes call the SAME function; neither holds a copy (§6).
    //
    // WHY THE PLAN IS KEYED ON THE CONTACT AND NOT THE LEAD, since this is the
    // one place both ids are in scope: leads are not assigned to agents until
    // qualified or showing positive intent, and on THIS lane assignment IS
    // conversion — the contact was created moments ago. An agent cannot even read
    // a lead: live `is_lead_visible_role()` admits broker / broker_admin /
    // broker_owner / admin / team_lead / superadmin / ISA / platform and NOT
    // `agent`, so §5 is enforced in the database, not merely in the product.
    // `activities.contact_id` and `messages.contact_id` are FKs to `contacts(id)`,
    // so a lead-keyed plan could not read its own evidence either.
    //
    // BEST EFFORT, like every step in this tail: the contact exists and the lead
    // is deactivated. A refused plan is a warning, never a rollback of a
    // successful assignment.
    {
      const { generateAgentActionPlan, persistAgentActionPlan } =
        await import('@/lib/agent-orchestration')
      const planned = await generateAgentActionPlan(contact.id, agentId, brokerageId, supabase)
      if (!planned.ok) {
        console.warn(
          `[lead-acquisition] agent action plan NOT generated for contact ${contact.id}: ${planned.reason}`,
        )
      } else {
        const persisted = await persistAgentActionPlan(supabase, planned.plan, brokerageId)
        for (const w of persisted.warnings) {
          console.error(`[lead-acquisition] agent action plan: ${w}`)
        }
        console.log(
          `[lead-acquisition] agent action plan for contact ${contact.id}: ` +
            `${persisted.written} action(s) written, consent basis '${planned.plan.consentBasis}'`,
        )
      }
    }
  }

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_CONVERTED_TO_CONTACT,
    brokerage_id: brokerageId,
    metadata: { contactId: contact.id },
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_ASSIGNED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_CONVERTED_TO_CONTACT,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  // Wave 38 — promote audience membership to the AGENT's FB
  // retargeting audience too (brokerage row stays). Non-blocking.
  try {
    const { onLeadConvertedForAudience } = await import('@/lib/audiences/audience-sync')
    void onLeadConvertedForAudience({
      contactId:   contact.id,
      leadId,
      brokerageId,
      agentUserId,
    }).catch((e) => {
      console.error('[lead-acquisition] FB audience promote failed:', e)
    })
  } catch { /* best-effort */ }

  // Content channel — RE-KEY the newsletter subscription from brokerage/team/solo scope to
  // the ASSIGNED AGENT now that the lead is a contact (owner's scoping rule). Best-effort.
  try {
    const { enrollContactInNewsletter } = await import('@/lib/content/newsletter-enrollment')
    void enrollContactInNewsletter({ contactId: contact.id, brokerageId, tier: 'contact' })
      .catch((e) => console.error('[lead-acquisition] newsletter enroll failed:', e))
  } catch { /* best-effort */ }

  // ── Post-conversion side-effects ──────────────────────────────────────
  // 1. Queue scoring + enrichment so the new contact has fresh data.
  // 2. Send portal invite for buyer/seller/investor contact types so they
  //    can self-serve from minute one. Cooperating-agent contacts and
  //    contacts without a real-estate intent skip the portal.
  try {
    const { queueContactEnrichmentAndScore } = await import(
      '@/lib/contact-pipeline/contact-capture'
    )
    await queueContactEnrichmentAndScore({
      brokerageId,
      contactId: contact.id,
    })
  } catch {
    // best effort — failure should not unwind the assignment
  }

  if (contactType === 'buyer' || contactType === 'seller' || contactType === 'investor') {
    try {
      // System path (server-only, not a client action): createPortalInviteForContact required a
      // logged-in session and silently failed here in the background assignment context.
      // createSystemPortalInvite authorizes via the assigned agent's user id; the core
      // compliance-gates the email on opt-out / unsubscribe.
      const { createSystemPortalInvite } = await import('@/lib/portal/portal-invite-core')
      await createSystemPortalInvite({
        contactId:   contact.id,
        agentUserId: agentUserId,
        sendMagicLink: true,
      })
    } catch {
      // best effort — agent can re-send invite from CRM if it failed
    }
  }
}

// ─── HANDLER 7 REMOVED — handleLeadConvertedToContact (manual path) ──────────
//
// TOMBSTONE. SURVIVOR: lib/kernel/crm.ts `convertLeadToContact` (the live manual
// path, reached from app/actions/lead-lifecycle.ts `convertLeadToContact`).
//
// This was a FOURTH conversion writer and a fifth spelling of conversion. It had
// ZERO call sites: the only other mentions in the tree were the barrel export in
// lib/kernel/index.ts and a stale name inside a comment in
// lib/audiences/audience-sync.ts. Reachability was PROVEN before deleting rather
// than inferred from the reference count — its siblings in this file are invoked
// by DIRECT IMPORT (handleLeadAssigned is imported at
// app/actions/lead-assignment/assign-lead.ts and app/actions/lead-acquisition.ts),
// there is no handler registry that dispatches them by name, and
// processKernelEvent routes to notification_rules rows, not to functions in this
// module. It emitted LEAD_CONVERTED_TO_CONTACT; it was never dispatched by it.
//
// MERGED ONTO THE SURVIVOR FIRST, then deleted. The one thing it carried that
// crm.ts lacked was the intent to be the manual conversion hook — and the actual
// audience promotion it never performed now lives in the survivor, crossing
// agents.user_id correctly. What it DID do (contact_id, converted_at,
// deactivateLead, the lifecycle row and the kernel fan-out) the survivor already
// did or now does.
//
// Deleting it is not moving a number: it removes a writer that, had anyone ever
// called it, would have been a fifth answer to "what does conversion stamp" — the
// exact divergence the conversion-finality guard exists to make impossible.
