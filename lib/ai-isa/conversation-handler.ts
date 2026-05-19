import { createServiceClient } from '@/lib/supabase/service'

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

export async function haltEngagementForNegativeReply(params: {
  leadId: string
  body: string
  brokerageId: string
}): Promise<boolean> {
  if (!detectNegativeIntent(params.body)) return false

  const supabase = createServiceClient()

  // Set call_stop_flag and dnc on the lead — prevents any future AI outreach
  await supabase
    .from('leads')
    .update({
      call_stop_flag: true,
      ai_isa_owner: false,
      lifecycle_state: 'do_not_contact',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.leadId)

  // If a contact record is linked, set dnc_status too
  const { data: lead } = await supabase
    .from('leads')
    .select('contact_id')
    .eq('id', params.leadId)
    .maybeSingle()

  if (lead?.contact_id) {
    await supabase
      .from('contacts')
      .update({
        dnc_status: true,
        isa_reengage_allowed: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', lead.contact_id)
  }

  // Log an activity so the agent sees this clearly in the timeline
  await supabase.from('activities').insert({
    contact_id: params.leadId,
    brokerage_id: params.brokerageId,
    activity_type: 'lead_opted_out',
    title: 'Lead requested no further contact',
    description: 'AI ISA detected negative reply. All automated outreach halted. DNC flag set.',
    status: 'completed',
    created_at: new Date().toISOString(),
  })

  // Notify the agent
  await supabase.from('notifications').insert({
    brokerage_id: params.brokerageId,
    type: 'lead_opted_out',
    title: 'Lead requested to be removed',
    message: 'A lead replied with an opt-out signal. They have been marked Do Not Contact.',
    entity_type: 'lead',
    entity_id: params.leadId,
    is_read: false,
  })

  return true
}

export async function shouldStopAutoResponding(leadId: string): Promise<boolean> {
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('lead_stage, lead_score, call_stop_flag, lifecycle_state')
    .eq('id', leadId)
    .single()

  if (!lead) return true

  // Stop immediately if DNC, call_stop_flag, or already qualified/handed off
  if (
    lead.call_stop_flag ||
    lead.lifecycle_state === 'do_not_contact' ||
    lead.lifecycle_state === 'qualified' ||
    lead.lifecycle_state === 'consented' ||
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
