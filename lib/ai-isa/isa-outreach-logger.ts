import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { CalendarEventType } from '@/lib/kernel/calendar-types'
import { processKernelEvent } from '@/lib/kernel'

// ── Entity discriminated union ────────────────────────────────────────────────
export type Entity =
  | { entityType: 'lead'; leadId: string }
  | { entityType: 'contact'; contactId: string }

// ── logISAOutreach ────────────────────────────────────────────────────────────

export async function logISAOutreach(params: {
  brokerageId: string
  agentId?: string
  entity: Entity
  channel: 'email' | 'sms' | 'phone' | 'direct_mail' | 'video' | 'social' | 'facebook' | 'instagram' | 'linkedin' | 'twitter'
  subject?: string
  bodySnippet?: string
  themFirstScore?: number | null
  compliancePassed?: boolean
  providerVideoId?: string
  lobLetterId?: string
}): Promise<void> {
  const supabase = createServiceClient()

  const entityType = params.entity.entityType
  const entityId =
    entityType === 'lead' ? params.entity.leadId : params.entity.contactId

  const calendarMap: Partial<Record<string, CalendarEventType>> = {
    email:       CalendarEventType.ISA_OUTREACH_EMAIL,
    direct_mail: CalendarEventType.ISA_DIRECT_MAIL,
    video:       CalendarEventType.ISA_VIDEO_SEND,
  }
  const calendarEventType = calendarMap[params.channel] ?? CalendarEventType.ISA_OUTREACH_EMAIL

  const now = new Date()
  const endAt = new Date(now.getTime() + 15 * 60 * 1000)

  // 1. INSERT calendar_events
  await supabase.from('calendar_events').insert({
    entity_type:          entityType,
    entity_id:            entityId,
    event_type:           calendarEventType,
    start_at:             now.toISOString(),
    end_at:               endAt.toISOString(),
    timezone_name:        'UTC',
    is_system_generated:  true,
    brokerage_id:         params.brokerageId,
  })

  // 2. INSERT ai_isa_activities
  await supabase.from('ai_isa_activities').insert({
    brokerage_id:    params.brokerageId,
    activity_type:   params.channel,
    channel:         params.channel,
    lead_id:         entityType === 'lead'    ? entityId : null,
    contact_id:      entityType === 'contact' ? entityId : null,
    summary:         params.bodySnippet ?? params.subject ?? null,
    them_first_score: params.themFirstScore ?? null,
    outcome:         'sent',
    created_at:      now.toISOString(),
  })

  // 3. For lead entities only — INSERT isa_outreach_log
  if (entityType === 'lead') {
    await supabase.from('isa_outreach_log').insert({
      lead_id:           entityId,
      brokerage_id:      params.brokerageId,
      agent_id:          params.agentId ?? null,
      channel:           params.channel,
      subject:           params.subject ?? null,
      body_snippet:      params.bodySnippet ?? null,
      provider_job_id:   params.providerVideoId ?? null,
      lob_letter_id:     params.lobLetterId ?? null,
      status:            'sent',
      them_first_score:  params.themFirstScore ?? null,
      compliance_passed: params.compliancePassed ?? true,
      created_at:        now.toISOString(),
    })
  }

  // 4. INSERT lifecycle_events
  await supabase.from('lifecycle_events').insert({
    entity_type: entityType,
    entity_id:   entityId,
    event_type:  KernelEvent.ISA_OUTREACH_SENT,
    metadata:    { channel: params.channel, subject: params.subject },
    created_at:  now.toISOString(),
  })

  // 5. processKernelEvent
  await processKernelEvent({
    event:       KernelEvent.ISA_OUTREACH_SENT,
    brokerageId: params.brokerageId,
    entityType,
    entityId,
  })
}

// ── checkMaxTouches ───────────────────────────────────────────────────────────

export async function checkMaxTouches(
  entityId: string,
  entityType: 'lead' | 'contact',
  brokerageId: string,
): Promise<boolean> {
  const supabase = createServiceClient()

  // Belt-and-suspenders: if the entity is suppressed, skip touch counting entirely.
  // evaluateOutbound is the primary gate — this ensures checkMaxTouches never logs
  // a touch against a DNC/opted-out entity even if called out of the normal gate order.
  const suppressionTable = entityType === 'contact' ? 'contacts' : 'leads'
  const { data: suppressCheck } = await supabase
    .from(suppressionTable)
    .select('dnc_status, email_opt_out')
    .eq('id', entityId)
    .maybeSingle()

  if (suppressCheck?.dnc_status || suppressCheck?.email_opt_out) {
    return false  // suppressed — do not count or send
  }

  let touchCount = 0

  if (entityType === 'lead') {
    const { count } = await supabase
      .from('isa_outreach_log')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', entityId)
    touchCount = count ?? 0
  } else {
    const { count } = await supabase
      .from('ai_isa_activities')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', entityId)
      .in('activity_type', ['email', 'direct_mail', 'video'])
    touchCount = count ?? 0
  }

  // Get max_touches from active campaign (default 5)
  const { data: campaign } = await supabase
    .from('ai_isa_campaigns')
    .select('max_touches')
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const maxTouches = campaign?.max_touches ?? 5

  if (touchCount >= maxTouches) {
    await supabase.from('lifecycle_events').insert({
      entity_type: entityType,
      entity_id:   entityId,
      event_type:  KernelEvent.ISA_MAX_TOUCHES_REACHED,
      metadata:    { touchCount, maxTouches },
      created_at:  new Date().toISOString(),
    })
    await processKernelEvent({
      event:       KernelEvent.ISA_MAX_TOUCHES_REACHED,
      brokerageId,
      entityType,
      entityId,
    })
    return false
  }

  return true
}

// ── checkUnderContractPause ───────────────────────────────────────────────────

export async function checkUnderContractPause(
  brokerageId: string,
  contactId: string,
  entityType: 'lead' | 'contact',
  entityId: string,
): Promise<boolean> {
  const supabase = createServiceClient()

  const { count } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('status', 'under_contract')

  if ((count ?? 0) > 0) {
    await supabase.from('lifecycle_events').insert({
      entity_type: entityType,
      entity_id:   entityId,
      event_type:  KernelEvent.ISA_OUTREACH_PAUSED,
      metadata:    { reason: 'under_contract' },
      created_at:  new Date().toISOString(),
    })
    await processKernelEvent({
      event:       KernelEvent.ISA_OUTREACH_PAUSED,
      brokerageId,
      entityType,
      entityId,
    })
    return true // paused
  }

  return false // not paused
}
