import { createServiceClient } from '@/lib/supabase/service'
import { isLeadHandedOff, isLeadSuppressed } from '@/lib/lead-pipeline/lead-lifecycle'

// Inbound-email orchestration lives in app/actions/ai-isa/handle-inbound-email.ts
// (uses generateTextRouted with kernel-validated tools from lib/ai-isa/tools.ts).
// This file now only owns the helper utilities used by that flow.

// Keywords that indicate negative intent — stop all AI outreach immediately
const NEGATIVE_INTENT_PHRASES = [
  'not interested',
  'no thanks',
  'stop',
  'unsubscribe',
  'remove me',
  'take me off',
  'do not contact',
  'don\'t contact',
  'leave me alone',
  'stop emailing',
  'stop contacting',
  'opt out',
  'opt-out',
  'cancel',
  'go away',
]

export function detectNegativeIntent(body: string): boolean {
  const lower = body.toLowerCase().trim()
  return NEGATIVE_INTENT_PHRASES.some((phrase) => lower.includes(phrase))
}

export interface HaltEngagementResult {
  /** True when a negative intent was detected and the halt path ran. */
  halted: boolean
  /** Set when the CONTACT-side suppression write was REFUSED. `halted` is still
   *  true (the intent was detected and everything else ran) but the contact row
   *  does NOT carry the DNC flags, so no caller may report the opt-out as done. */
  contactSuppressionError?: string
}

/**
 * WHY THIS RETURNS A RESULT (it used to return a bare boolean).
 *
 * The contacts write below is the consumer's opt-out. supabase-js RESOLVES a
 * refused UPDATE, and this function discarded that result, so every caller —
 * handle-inbound-email ("negative_reply_dnc_set"), classifyAndRouteInbound
 * ("halted"), and the ISA's own mark_do_not_contact tool ({ success: true },
 * read back by the model) — reported a Do-Not-Contact that the row never took.
 * That is a fail-open on suppression, which CLAUDE.md §4 forbids. The error is
 * read here and each caller stops claiming success on it.
 */
export async function haltEngagementForNegativeReply(params: {
  leadId: string
  body: string
  brokerageId: string
}): Promise<HaltEngagementResult> {
  if (!detectNegativeIntent(params.body)) return { halted: false }

  const supabase = createServiceClient()

  // Set call_stop_flag and dnc on the lead — prevents any future AI outreach.
  //
  // This used to also write lifecycle_state: 'do_not_contact', which the column's
  // CHECK does not admit. supabase-js reports a rejected update in { error }
  // instead of throwing, and the result was discarded — so the WHOLE update was
  // lost, call_stop_flag included. A lead who asked to be left alone was not
  // marked as having asked. Suppression belongs on the flags; lifecycle_state has
  // no value for it and is not a suppression column.
  const { error: suppressError } = await supabase
    .from('leads')
    .update({
      call_stop_flag: true,
      dnc_status: true,
      ai_isa_owner: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.leadId)
  if (suppressError) {
    console.error('[haltEngagementForNegativeReply] lead suppression failed:', suppressError)
  }

  // If a contact record is linked, set dnc_status too
  const { data: lead } = await supabase
    .from('leads')
    .select('contact_id')
    .eq('id', params.leadId)
    .maybeSingle()

  let contactSuppressionError: string | undefined
  if (lead?.contact_id) {
    const { error: contactSuppressError } = await supabase
      .from('contacts')
      .update({
        dnc_status: true,
        isa_reengage_allowed: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', lead.contact_id)
    if (contactSuppressError) {
      contactSuppressionError = contactSuppressError.message
      console.error(
        `[haltEngagementForNegativeReply] contact suppression REFUSED for contact ${lead.contact_id}:`,
        contactSuppressError.message,
      )
    }
  }

  // Log an activity so the agent sees this clearly in the timeline.
  // The comment below records that this row was FK-rejected and "was never
  // written" — invisibly. Reading the error is what stops that recurring.
  const { error: optOutTimelineError } = await supabase.from('activities').insert({
    // activities.contact_id FKs contacts(id) — a lead id here violates the FK and
    // the insert is rejected, so the timeline entry the agent is supposed to see
    // was never written. Leads travel on entity_type/entity_id.
    contact_id: null,
    entity_type: 'lead',
    entity_id: params.leadId,
    brokerage_id: params.brokerageId,
    activity_type: 'lead_opted_out',
    title: 'Lead requested no further contact',
    description: 'AI ISA detected negative reply. All automated outreach halted. DNC flag set.',
    status: 'completed',
    created_at: new Date().toISOString(),
  })
  if (optOutTimelineError) {
    console.error('[conversationHandler] lead_opted_out activity REJECTED — the agent will not see the opt-out on the timeline:', optOutTimelineError.message)
  }

  // Notify the agent
  await supabase.from('notifications').insert({
    brokerage_id: params.brokerageId,
    type: 'lead_opted_out',
    title: 'Lead requested to be removed',
    // notifications uses body, not message — the phantom failed the insert, so the
    // agent was never told a lead opted out (a compliance-relevant blind spot).
    body: 'A lead replied with an opt-out signal. They have been marked Do Not Contact.',
    entity_type: 'lead',
    entity_id: params.leadId,
    is_read: false,
  })

  return { halted: true, contactSuppressionError }
}

export async function shouldStopAutoResponding(leadId: string): Promise<boolean> {
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('lead_stage, lead_score, call_stop_flag, dnc_status, lifecycle_state')
    .eq('id', leadId)
    .single()

  if (!lead) return true

  // Stop immediately if suppressed, or already handed off to a human.
  // 'do_not_contact' and 'qualified' were tested here and neither is in the
  // lifecycle vocabulary — the only live arm of this condition was 'consented',
  // so a lead already assigned, booked, or under representation kept getting
  // auto-replies from the ISA.
  if (
    isLeadSuppressed(lead) ||
    isLeadHandedOff(lead.lifecycle_state) ||
    lead.lead_stage === 'qualified' ||
    lead.lead_score > 75
  ) {
    return true
  }

  // Stop after 5 back-and-forth exchanges (10 total messages = 5 each side)
  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', leadId)
    .eq('type', 'email')

  if ((count ?? 0) >= 10) return true

  return false
}
