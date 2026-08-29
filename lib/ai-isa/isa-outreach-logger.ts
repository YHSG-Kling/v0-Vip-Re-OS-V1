import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { CalendarEventType } from '@/lib/kernel/calendar-types'
import { processKernelEvent } from '@/lib/kernel'
import { sentinelWrite } from '@/lib/kernel/write-sentinel'

// ── The touch cap, in ONE place ───────────────────────────────────────────────
// `ai_isa_campaigns.max_touches` is what the governor below enforces. It carries
// a DDL default of 5, and this constant is the same number so a campaign row
// that predates the create-drawer wiring behaves identically to one that sets it
// explicitly. The bounds exist because the value is broker-supplied: 0 would
// suppress a campaign silently (it looks identical to "nobody replied"), and an
// unbounded number is a harassment cap, not a cap.
export const ISA_DEFAULT_MAX_TOUCHES = 5
export const ISA_MIN_MAX_TOUCHES = 1
export const ISA_MAX_MAX_TOUCHES = 20

/** PURE: broker-supplied touch cap → the value the column may hold. */
export function clampMaxTouches(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ISA_DEFAULT_MAX_TOUCHES
  return Math.min(ISA_MAX_MAX_TOUCHES, Math.max(ISA_MIN_MAX_TOUCHES, Math.round(value)))
}

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

  // 1. INSERT calendar_events — sentinel-tracked: an unchecked await here
  // swallows PostgREST { error } results. Pass 3 proved this class hid
  // months of CHECK-rejected rows; every loss now ledgers to self_heal_events.
  await sentinelWrite(supabase, supabase.from('calendar_events').insert({
    entity_type:          entityType,
    entity_id:            entityId,
    event_type:           calendarEventType,
    start_at:             now.toISOString(),
    end_at:               endAt.toISOString(),
    timezone_name:        'UTC',
    is_system_generated:  true,
    brokerage_id:         params.brokerageId,
  }), { table: 'calendar_events', flow: 'isa_outreach_record', brokerageId: params.brokerageId })

  // 2. INSERT ai_isa_activities — activity_type + channel CHECKs are live
  // vocabularies (pass-3 verified). The caller's wider channel set normalizes:
  // sms→text / phone→call for activity_type (the CHECK's canonical synonyms),
  // per-network socials → 'social' on both columns. Before this mapping the
  // sms/phone/social activity rows FAILED the CHECK silently and the ISA's
  // activity feed lost them.
  const ACTIVITY_TYPE: Record<string, string> = {
    sms: 'text', phone: 'call',
    facebook: 'social', instagram: 'social', linkedin: 'social', twitter: 'social',
  }
  const ACTIVITY_CHANNEL: Record<string, string> = {
    facebook: 'social', instagram: 'social', linkedin: 'social', twitter: 'social',
  }
  await sentinelWrite(supabase, supabase.from('ai_isa_activities').insert({
    brokerage_id:    params.brokerageId,
    activity_type:   ACTIVITY_TYPE[params.channel] ?? params.channel,
    channel:         ACTIVITY_CHANNEL[params.channel] ?? params.channel,
    lead_id:         entityType === 'lead'    ? entityId : null,
    contact_id:      entityType === 'contact' ? entityId : null,
    summary:         params.bodySnippet ?? params.subject ?? null,
    them_first_score: params.themFirstScore ?? null,
    outcome:         'sent',
    created_at:      now.toISOString(),
  }), { table: 'ai_isa_activities', flow: 'isa_outreach_record', brokerageId: params.brokerageId })

  // 3. For lead entities only — INSERT isa_outreach_log
  if (entityType === 'lead') {
    // isa_outreach_log.channel CHECK allows {email, direct_mail, video, sms,
    // in_app, voice, social} (live-verified). The wider caller vocabulary is
    // normalized here — 'phone' IS the voice channel, and the per-network
    // socials collapse to 'social' (the network stays in subject/body).
    // Before this mapping, phone/social sends FAILED the CHECK silently and
    // the lead's outreach record was lost.
    const LOG_CHANNEL: Record<string, string> = {
      phone: 'voice',
      facebook: 'social', instagram: 'social', linkedin: 'social', twitter: 'social',
    }
    await sentinelWrite(supabase, supabase.from('isa_outreach_log').insert({
      lead_id:           entityId,
      brokerage_id:      params.brokerageId,
      agent_id:          params.agentId ?? null,
      channel:           LOG_CHANNEL[params.channel] ?? params.channel,
      subject:           params.subject ?? null,
      body_snippet:      params.bodySnippet ?? null,
      provider_job_id:   params.providerVideoId ?? null,
      lob_letter_id:     params.lobLetterId ?? null,
      status:            'sent',
      them_first_score:  params.themFirstScore ?? null,
      compliance_passed: params.compliancePassed ?? true,
      created_at:        now.toISOString(),
    }), { table: 'isa_outreach_log', flow: 'isa_outreach_record', brokerageId: params.brokerageId })
  }

  // 3b. STAMP THE QUALIFICATION'S LAST TOUCH.
  //
  // `ai_isa_qualifications.last_outreach_at` was read by code and written by
  // nobody (census 1b), and the reader does not degrade quietly: the lead
  // lineage board's staleness test is
  //
  //     const lastTouch = …last_outreach_at… ; if (!lastTouch) return true
  //     (app/dashboard/admin/lead-lineage/lead-lineage-client.tsx:127-131)
  //
  // so EVERY lead that had a qualification row was flagged STALE — including
  // one the ISA had emailed minutes earlier. A board whose whole job is to show
  // which leads are going cold was marking all of them cold.
  //
  // This is the moment the fact becomes known: a touch has just been sent. The
  // stamp goes on the qualification rows for this entity (open or not — the
  // column records when we last reached out, not whether we are still working
  // it). Best-effort: the outreach itself is the deliverable, but a refusal is
  // never silent, because a silent refusal is what the board was already
  // showing.
  {
    const qualFilter = entityType === 'lead' ? 'lead_id' : 'contact_id'
    const { error: touchErr } = await supabase
      .from('ai_isa_qualifications')
      .update({ last_outreach_at: now.toISOString() })
      .eq('brokerage_id', params.brokerageId)
      .eq(qualFilter, entityId)
    if (touchErr) {
      console.error('[ISA] last_outreach_at NOT stamped — the lineage board will read this lead as stale:', touchErr.message)
    }
  }

  // 3c. ENGAGEMENT TRACKING — the provider job ids the feed reads back.
  //
  // `ai_isa_engagement_tracking.metadata` was read by code and written by nobody
  // (census 1b): app/actions/ai-isa.ts:628-629 pulls `did_video_id` /
  // `heygen_video_id` / `lob_letter_id` OUT of it for every row of the
  // engagement feed, so the feed's video and direct-mail columns were blank on
  // every row — and worse, no video or direct-mail send had ever landed an
  // engagement row at all (the only four writers of that table are the
  // email-only ghost-recovery actions), so those channels were invisible on the
  // feed entirely. This function already receives both provider ids; this is
  // where they become known.
  //
  // CONTACT ENTITIES ONLY: the feed is contact-keyed (it embeds
  // `contacts (first_name, last_name)`), and the lead side already has its own
  // ledger in `isa_outreach_log` above. Writing a lead id into contact_id would
  // be the FK violation supabase-js resolves silently.
  //
  // `channel` is a live CHECK — {direct_mail, email, phone, sms, system, video}
  // (scripts/check-vocabularies.ts:202) — and the caller's wider vocabulary is
  // normalized onto it here for the same reason steps 2 and 3 normalize theirs:
  // a value outside the CHECK is refused ENTIRELY, not partially.
  if (entityType === 'contact') {
    const ENGAGEMENT_CHANNEL: Record<string, string> = {
      facebook: 'system', instagram: 'system', linkedin: 'system', twitter: 'system', social: 'system',
    }
    await sentinelWrite(supabase, supabase.from('ai_isa_engagement_tracking').insert({
      brokerage_id: params.brokerageId,
      contact_id:   entityId,
      channel:      ENGAGEMENT_CHANNEL[params.channel] ?? params.channel,
      event_type:   'sent',
      event_at:     now.toISOString(),
      // Only ids we actually hold. An absent provider id is omitted rather than
      // stored as null, so `metadata.did_video_id` means "there is a video job"
      // and its absence means "there is not" — never "we forgot to look".
      metadata: {
        ...(params.providerVideoId ? { did_video_id: params.providerVideoId } : {}),
        ...(params.lobLetterId ? { lob_letter_id: params.lobLetterId } : {}),
        source_channel: params.channel,
      },
    }), { table: 'ai_isa_engagement_tracking', flow: 'isa_outreach_record', brokerageId: params.brokerageId })
  }

  // 4. INSERT lifecycle_events — brokerage_id is NOT NULL (pass 5 live
  // catch): without it this insert ALWAYS failed and the ISA's outreach
  // never reached the lifecycle stream.
  await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
    brokerage_id: params.brokerageId,
    entity_type: entityType,
    entity_id:   entityId,
    event_type:  KernelEvent.ISA_OUTREACH_SENT,
    metadata:    { channel: params.channel, subject: params.subject },
    created_at:  now.toISOString(),
  }), { table: 'lifecycle_events', flow: 'isa_outreach_record', brokerageId: params.brokerageId })

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
      // Every OUTREACH type counts as a touch (parity with the lead side,
      // which counts all isa_outreach_log rows). text/call/voicedrop/social
      // were previously invisible to the cap.
      .in('activity_type', ['email', 'direct_mail', 'video', 'text', 'call', 'voicedrop', 'social'])
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

  const maxTouches = campaign?.max_touches ?? ISA_DEFAULT_MAX_TOUCHES

  if (touchCount >= maxTouches) {
    await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
      brokerage_id: brokerageId, // NOT NULL (pass 5): missing → the event never landed
      entity_type: entityType,
      entity_id:   entityId,
      event_type:  KernelEvent.ISA_MAX_TOUCHES_REACHED,
      metadata:    { touchCount, maxTouches },
      created_at:  new Date().toISOString(),
    }), { table: 'lifecycle_events', flow: 'isa_touch_governor', brokerageId })
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
    await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
      brokerage_id: brokerageId, // NOT NULL (pass 5): missing → the pause was never recorded
      entity_type: entityType,
      entity_id:   entityId,
      event_type:  KernelEvent.ISA_OUTREACH_PAUSED,
      metadata:    { reason: 'under_contract' },
      created_at:  new Date().toISOString(),
    }), { table: 'lifecycle_events', flow: 'isa_touch_governor', brokerageId })
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
