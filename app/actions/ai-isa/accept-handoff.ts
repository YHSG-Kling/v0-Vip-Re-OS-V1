'use server'

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from '@/lib/supabase/service'
import { getAgentContext } from '@/lib/identity/get-agent-context'

/**
 * AI-ISA handoff acceptance — the VOICE channel's entry into the canonical
 * qualify → assign → convert chain (also callable from the UI).
 *
 * Canonical business process: leads are AI-ISA + brokerage owned while
 * unconsented; a positive ISA conversation IS the qualification + consent
 * signal, after which the engine assigns per the contact-assignment settings
 * (owner → solo → team rules/fallback → brokerage → load-balance) and the
 * assignment CONVERTS the lead to a lossless contact (createContactFromLead,
 * agents.id).
 *
 * This replaced a side door that (a) stamped users.id from a "primary agent"
 * fallback into the agent slot — making converted contacts INVISIBLE to their
 * agents via RLS, (b) bypassed tier-aware routing entirely, and (c) contained
 * a leftover broken edit inserting junk notification rows on every handoff.
 */
export async function acceptAIISAHandoff(params: {
  leadId: string
  brokerageId: string
  actorUserId: string
  /** Set ONLY by trusted in-process callers (the intent converters) — CRON_SECRET. */
  internalSecret?: string
}): Promise<{ success: boolean; contactId?: string; error?: string }> {
  const service = createServiceClient()

  // ── AUTH GATE ────────────────────────────────────────────────────────────
  // Two valid callers:
  //   1. UI (session-authenticated agent/broker) — verify ctx.brokerageId
  //   2. Trusted server-to-server (the intent converters reached from the voice
  //      webhooks, which verify their own signature) — actorUserId === 'system'
  //      AND the caller PRESENTS the CRON_SECRET (lane 86E).
  // WAS: `actorUserId === 'system' && !!process.env.CRON_SECRET` — the env var's
  // mere PRESENCE was the credential, and both halves are free to a browser: this
  // is a "use server" export (a public endpoint, CLAUDE.md §4), so a POST with
  // { actorUserId: "system", brokerageId: <any>, leadId: <any> } converted another
  // tenant's lead on the service client with no session at all. The secret must
  // now be SUPPLIED and match — the same shape processInboundEmail and
  // lead-signal-ingest already use.
  const ctx = await getAgentContext()
  const cronSecret = process.env.CRON_SECRET
  const isSystemCaller =
    params.actorUserId === 'system' && !!cronSecret && !!params.internalSecret && params.internalSecret === cronSecret
  if (!isSystemCaller) {
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: 'Unauthorized' }
    }
    if (!params.brokerageId || !decideClaimedTenant({ actingBrokerageId: ctx.brokerageId, claimedBrokerageId: params.brokerageId }).ok) { // The claimed-tenant rule is the ONE decision table (lane 93A, §6) — not a hand-rolled copy. REQUIRED here (the lead read below is keyed by it): an absent one refuses too.
      return { success: false, error: 'Forbidden' }
    }
  }

  const { data: lead, error: leadErr } = await service
    .from('leads')
    .select('id, brokerage_id, agent_id, contact_id, lifecycle_state, lead_stage, lead_score')
    .eq('id', params.leadId)
    .eq('brokerage_id', params.brokerageId)
    .maybeSingle()

  if (leadErr || !lead) {
    return { success: false, error: 'Lead not found' }
  }
  if (lead.brokerage_id !== params.brokerageId) {
    return { success: false, error: 'Forbidden' }
  }

  // Already converted — just open the contact
  if (lead.contact_id) {
    return { success: true, contactId: lead.contact_id }
  }

  try {
    // 1. Consent — a positive voice conversation is an engaged reply. The kernel
    //    handler is the SOLE lifecycle_state writer (isa_qualifying → consented).
    if (lead.lifecycle_state !== 'consented' && lead.lifecycle_state !== 'qualified') {
      const { handleConsentReceived } = await import('@/lib/kernel/lead-acquisition-handlers')
      await handleConsentReceived({
        leadId: lead.id,
        brokerageId: lead.brokerage_id,
        consentSource: 'reply',
      })
    }

    // 2. Qualified — satisfies Engine 2's gate (lead_stage='qualified' + consented).
    if (lead.lead_stage !== 'qualified') {
      const { error: qualifyErr } = await service
        .from('leads')
        .update({ lead_stage: 'qualified', ai_isa_owner: false, updated_at: new Date().toISOString() })
        .eq('id', lead.id)
      if (qualifyErr) return { success: false, error: `Could not mark the lead qualified for hand-off: ${qualifyErr.message}` }
    }

    // 3. Engine 2 — the ONE assignment path: tier-aware routing (solo/team/brokerage/
    //    multi-location), assignment_log, and the canonical lossless conversion
    //    (handleLeadAssigned → createContactFromLead, agents.id).
    const { evaluateAndAssignLead } = await import('@/lib/lead-assignment/assignment-engine')
    const assignResult = await evaluateAndAssignLead({
      leadId: lead.id,
      brokerageId: lead.brokerage_id,
    })
    if (!assignResult.assigned) {
      return { success: false, error: `Assignment failed: ${assignResult.reason}` }
    }
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Handoff failed' }
  }

  // The conversion stamped leads.contact_id — read it back for the caller.
  const { data: after } = await service
    .from('leads')
    .select('contact_id')
    .eq('id', lead.id)
    .maybeSingle()
  const contactId = after?.contact_id ?? undefined
  if (!contactId) {
    return { success: false, error: 'Contact was not created — check lead conversion logs' }
  }

  // Notify the human actor (UI callers only — 'system' is not a users.id).
  if (!isSystemCaller) {
    try {
      await sentinelWrite(service, service.from('notifications').insert({
        brokerage_id: lead.brokerage_id,
        user_id: params.actorUserId,
        type: 'ai_handoff_completed',
        title: 'AI-ISA handoff accepted',
        body: 'Lead has been converted to a contact and is ready for follow-up.',
        entity_type: 'contact',
        entity_id: contactId,
        priority: 'high',
      }), { table: "notifications", flow: "accept_handoff_notify", brokerageId: lead.brokerage_id, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
    } catch { /* non-blocking */ }
  }

  try {
    await sentinelWrite(service, service.from('lifecycle_events').insert({
      entity_type: 'lead',
      entity_id: lead.id,
      brokerage_id: lead.brokerage_id,
      event_type: 'AI_ISA_HANDOFF_ACCEPTED',
      metadata: { actorUserId: params.actorUserId, contactId, channel: 'voice_or_ui', manager: 'ai_isa' },
      created_at: new Date().toISOString(),
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })
  } catch { /* non-blocking */ }

  return { success: true, contactId }
}

// Imported at the foot (lane 93A) so the file:line references other files hold into this one stay true (ES imports hoist).
import { decideClaimedTenant } from "@/lib/platform/acting-context"
