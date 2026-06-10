// lib/intelligence/isa-overnight.ts
//
// AI ISA — the agent briefing's "what your ISA did overnight" section. PURE module
// (no DB/AI imports) so the qualification simulator regression-tests the exact
// prioritization the agent sees each morning.
//
// Business process this surfaces: the AI ISA owns leads until qualified; on
// qualification, Engine 2 assigns (tier-routed) and converts to a contact. The human
// agent's morning job is the FIRST TOUCH on those handoffs — speed-to-first-touch is
// the metric that converts. An unclaimed handoff is therefore the highest-severity
// item the briefing can show.

import type { PriorityAction } from './daily-briefing-generator'

export interface IsaHandoffRow {
  lead_id: string
  lead_name: string
  claimed: boolean
  assignment_method: string | null
  assigned_at: string
}

export interface IsaEscalationRow {
  lead_id: string | null
  message: string
  urgency: string | null
}

export interface IsaOvernightInput {
  /** assignment_log rows for THIS agent in the last 24h (the ISA's handoffs). */
  handoffs: IsaHandoffRow[]
  /** Unread isa_escalation notifications for this user. */
  escalations: IsaEscalationRow[]
  /** Count of ISA-owned leads currently marked hot (rolling lead_temperature). */
  hotIsaLeadCount: number
}

export interface IsaOvernightSection {
  handoffs_total: number
  handoffs_unclaimed: number
  escalations: number
  hot_isa_leads: number
  /** One agent-readable line for the summary strip. */
  summary_line: string
  /** Handoffs awaiting first touch (the actionable subset, capped). */
  unclaimed: Array<{ lead_id: string; lead_name: string; assigned_at: string }>
}

export function buildIsaOvernightSection(input: IsaOvernightInput): IsaOvernightSection {
  const unclaimed = input.handoffs
    .filter((h) => !h.claimed)
    .sort((a, b) => a.assigned_at.localeCompare(b.assigned_at)) // oldest first — longest-waiting lead leads
    .slice(0, 5)
    .map((h) => ({ lead_id: h.lead_id, lead_name: h.lead_name, assigned_at: h.assigned_at }))

  const parts: string[] = []
  if (input.handoffs.length > 0) {
    parts.push(
      `AI ISA qualified and assigned you ${input.handoffs.length} lead${input.handoffs.length === 1 ? '' : 's'} overnight` +
      (unclaimed.length > 0 ? ` — ${unclaimed.length} awaiting your first touch` : ', all claimed'),
    )
  }
  if (input.escalations.length > 0) {
    parts.push(`${input.escalations.length} ISA escalation${input.escalations.length === 1 ? '' : 's'} need a human`)
  }
  if (input.hotIsaLeadCount > 0) {
    parts.push(`ISA is working ${input.hotIsaLeadCount} hot conversation${input.hotIsaLeadCount === 1 ? '' : 's'}`)
  }

  return {
    handoffs_total: input.handoffs.length,
    handoffs_unclaimed: unclaimed.length,
    escalations: input.escalations.length,
    hot_isa_leads: input.hotIsaLeadCount,
    summary_line: parts.join('. '),
    unclaimed,
  }
}

/**
 * Deterministic priority items merged into the briefing's top_priority_actions —
 * NOT routed through the AI prompt, so a handoff can never be dropped by a model's
 * judgment call. Unclaimed handoffs outrank everything the ISA produced; critical
 * escalations match them.
 */
export function isaPriorityActions(section: IsaOvernightSection, escalations: IsaEscalationRow[]): PriorityAction[] {
  const actions: PriorityAction[] = []

  for (const h of section.unclaimed.slice(0, 3)) {
    actions.push({
      priority: 'high',
      action: `First touch: ${h.lead_name} (ISA-qualified, assigned to you)`,
      context: 'Qualified by the AI ISA and awaiting your first contact — speed-to-first-touch drives conversion.',
      entity_type: 'contact',
      entity_id: h.lead_id,
      action_type: 'view_lead',
    } as PriorityAction)
  }

  for (const e of escalations.slice(0, 2)) {
    actions.push({
      priority: e.urgency === 'critical' ? 'high' : 'medium',
      action: 'ISA escalation: lead asked for a human',
      context: e.message,
      entity_type: e.lead_id ? 'contact' : null,
      entity_id: e.lead_id,
      action_type: e.lead_id ? 'view_lead' : null,
    } as PriorityAction)
  }

  return actions
}
