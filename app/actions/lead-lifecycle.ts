'use server'

import { createClient } from '@/lib/supabase/server'
import {
  resolveLeadVisibilityForSession,
  applyLeadRowScope,
  type LeadRowScope,
} from '@/lib/auth/lead-visibility'
import { createPortalInviteForContact } from './portal-invites'
import { syncContactToCRM } from '@/lib/crm/sync'
import { convertLeadToContact as kernelConvertLeadToContact } from '@/lib/kernel'

// TOMBSTONE (lead-visibility consolidation): the inline `LEAD_DESK_ROLES` set is
// DELETED. The survivor is lib/auth/lead-visibility.ts:resolveLeadVisibility
// (session entry point `resolveLeadVisibilityForSession`).
//
// The policy note that stood here said team leads "never work lead rows". That
// is superseded by the owner's ruling — "if team tier subscriptions, they don't
// have a broker in the subscription so the team lead can see leads" — and the
// admission arrives with a ROW SCOPE, so it does not become brokerage-wide
// reach on a tenant that has more than one team.
//
// REMOVED FROM THIS SITE, named rather than dropped silently:
//   · 'superadmin' as a user_type comparison — measured DEAD (0 live rows hold
//     it; the platform's one superadmin is user_type='admin' with
//     platform_role='superadmin'). Platform staff keep their cross-brokerage
//     reach through the survivor's isPlatformStaffIdentity arm, which reads the
//     column that holds the answer.
//   · 'broker_admin' — not a storable user_type, so the comparison matched
//     nothing. It survives only as an input spelling inside the one roster.
//
// The caller-supplied `brokerageId` is STILL verified against the session and
// still never trusted — it is now checked against the scope the session
// resolved, which is the same rule with the team half added.

/**
 * Session-derived lead-desk gate, returning the caller's ROW SCOPE.
 *
 * `targetBrokerageId` remains an INPUT to be VERIFIED, never a source of truth:
 * a tenant actor must be acting inside the brokerage their own session resolved
 * to. Platform staff may act across brokerages (support/repair paths), which is
 * what `scope.kind === 'platform'` expresses.
 */
async function requireLeadDesk(targetBrokerageId: string): Promise<LeadRowScope> {
  const supabase = await createClient()
  const vis = await resolveLeadVisibilityForSession(supabase)
  if (!vis.allowed) {
    throw new Error(
      vis.status === 'forbidden'
        ? 'Forbidden — leads are managed at the brokerage level'
        : vis.reason,
    )
  }
  if (vis.scope.kind !== 'platform' && vis.scope.brokerageId !== targetBrokerageId) {
    throw new Error('Forbidden — brokerage mismatch')
  }
  return vis.scope
}

export async function listUnassignedLeads(params: {
  brokerageId: string
  limit?: number
  leadStage?: string
  motivationType?: string
}) {
  const supabase = await createClient()
  const { brokerageId, limit = 50, leadStage, motivationType } = params
  const scope = await requireLeadDesk(brokerageId)

  // THE UNASSIGNED POOL IS THE BROKERAGE'S, NOT A TEAM'S. `leads` carries no team
  // column; a lead's only link to a team is `agent_id → agents.team_id`, and an
  // unworked lead has no agent_id. So under a TRUE team scope this list is empty
  // by construction, and it is returned empty rather than being silently widened
  // to the brokerage — that widening is the failure this consolidation prevents.
  // Where the actor's team IS the whole tenant the resolver already collapsed the
  // scope to 'brokerage' and this list is fully visible, which is the owner's case.
  if (scope.kind === 'team') {
    return { success: true, leads: [], total: 0, count: 0 }
  }

  let query = supabase
    .from('leads')
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      source,
      lead_type,
      motivation_type,
      motivation_confidence,
      property_interest,
      lead_stage,
      enrichment_status,
      enrichment_confidence,
      created_at
    `)
    .eq('brokerage_id', brokerageId)
    .is('agent_id', null)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (leadStage) {
    query = query.eq('lead_stage', leadStage)
  }

  if (motivationType) {
    query = query.eq('motivation_type', motivationType)
  }

  const { data: leads, error } = await query

  if (error) {
    throw new Error(`Failed to list leads: ${error.message}`)
  }

  return {
    success: true,
    leads: leads || [],
    total: leads?.length || 0,
    count: leads?.length || 0
  }
}

// DELETED — `claimLead`. It set leads.agent_id and lead_stage='claimed' with a bare
// UPDATE, had zero callers, and in a 'use server' file every export is a reachable HTTP
// endpoint: it was a live second door onto the one column the assignment policy owns.
//
// SURVIVOR: app/actions/lead-assignment/assign-lead.ts:136 `manualAssignLead` (admin-manual)
// and :102 `assignLead` (automatic). Both route through handleLeadAssigned, so the
// conversion, the LEAD_ASSIGNED / LEAD_CONVERTED_TO_CONTACT fan-out and the assignment_log
// ledger row all happen — none of which this function did. The claim ACKNOWLEDGEMENT half
// lives at lib/lead-assignment/assignment-engine.ts:195, reached through
// app/actions/lead-assignment/assign-lead.ts:226 acknowledgeLeadHandoffAction.
//
// MOVED, NOT LOST: the one check the survivor lacked — refusing a deactivated lead — was
// added to manualAssignLead before this was removed.
//
// It also contradicts the standing ruling that agents never claim leads: leads belong to
// the brokerage, and an agent receives work as a CONTACT after automatic promotion.

export async function convertLeadToContact(params: {
  leadId: string
  agentId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { leadId, agentId, brokerageId } = params
  const scope = await requireLeadDesk(brokerageId)

  // The row scope is on the FETCH, so a team lead converting a lead outside their
  // own board gets "Lead not found" rather than a row. The brokerage equality
  // check below is kept as well: under platform scope there is no brokerage pin
  // in the scope at all, and the caller-supplied brokerageId still has to match
  // the row it names.
  const { data: lead, error: fetchError } = await applyLeadRowScope(
    supabase.from('leads').select('*').eq('id', leadId),
    scope,
  ).maybeSingle()

  if (fetchError || !lead) {
    throw new Error('Lead not found')
  }

  if (lead.brokerage_id !== brokerageId) {
    throw new Error('Lead does not belong to this brokerage')
  }

  if (!lead.agent_id) {
    throw new Error('Lead must be assigned before conversion')
  }

  // Core conversion via the single canonical kernel command: dedup +
  // contact creation (valid contact_type/persona) + leads.contact_id link +
  // lifecycle_state='assigned' + LEAD_CONVERTED_TO_CONTACT event (this comment
  // said CONTACT_LEAD_CONVERTED until that second spelling was retired — see the
  // tombstone at lib/kernel/events.ts:524). The prior inline
  // insert here skipped the link/state/event and had no dedup (drift).
  // QUALIFICATION GATE (owner, round 37): the kernel command REFUSES leads the
  // AI ISA has not marked lead_stage='qualified' — a broker may convert an
  // already-qualified lead, never an unqualified one. The refusal is RETURNED
  // (not thrown) so the UI can show the real reason — production masks thrown
  // server-action messages.
  const result = await kernelConvertLeadToContact({
    leadId,
    brokerageId,
    agentId,                       // agents.id
    tcpaConsent: true,             // manual agent-initiated conversion asserts consent
    consentSource: 'manual_lead_conversion',
  })
  if (!result.success || !result.contactId) {
    return {
      success: false as const,
      contactId: undefined,
      portalInviteCreated: false,
      message: result.error ?? 'Failed to convert lead to contact',
    }
  }
  const contact = { id: result.contactId }

  // Also flip is_active off (the kernel sets lifecycle_state='assigned'/contact_id).
  await supabase.from('leads').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', leadId)

  // Non-blocking CRM sync — do not fail the conversion if CRM is not configured
  void syncContactToCRM({
    firstName: lead.first_name,
    lastName: lead.last_name,
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    tags: [lead.lead_type, lead.motivation_type, lead.source].filter(Boolean) as string[],
    source: lead.source ?? "lead_conversion",
    brokerageId,
    agentId,
  })

  // Resolve users.id from agents.id for the invite (non-blocking)
  let portalInviteCreated = false
  try {
    const { data: agentRow } = await supabase
      .from('agents')
      .select('user_id')
      .eq('id', agentId)
      .maybeSingle()

    if (agentRow?.user_id) {
      const inviteResult = await createPortalInviteForContact({
        contactId: contact.id,
        brokerageId,
        invitedByUserId: agentRow.user_id,
        sendMagicLink: false,
      })
      portalInviteCreated = inviteResult.success
    }
  } catch {
    // Non-blocking — do not fail the conversion if the invite fails
  }

  return {
    success: true,
    contactId: contact.id,
    portalInviteCreated,
    message: 'Lead converted to contact successfully'
  }
}

