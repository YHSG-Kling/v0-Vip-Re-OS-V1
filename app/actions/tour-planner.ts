'use server'

/**
 * SYSTEM 5.1 — BUYER TOUR PLANNER (L5-B03)
 * Server actions: create tours, confirm stops, rate showings, complete tours.
 * All writes go to tours, tour_stops, showings, buyer_behavior_log, lifecycle_events.
 */

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { emitLifecycleTransition } from '@/lib/buyer-lifecycle/lifecycle-logger'
import { updateBuyerPreferences } from '@/lib/behavior-learning'
import { isValidUUID } from '@/lib/validations'

// ─── Auth helper ──────────────────────────────────────────────────────────────
//
// Every tour mutation previously trusted caller-supplied agentUserId /
// brokerageId / contactId. Any signed-in user could create tours under a
// different brokerage, confirm/finalize/complete other agents' tours, and
// pollute buyer behavior signals. Reads were equally open. This helper
// resolves the caller's identity once; all functions then ignore the
// caller-supplied IDs and use the session-derived values.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Unauthorized' }
  const { data: u } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: 'Unauthorized' }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TourStop {
  listingId?: string
  propertyAddress: string
  city?: string
  state?: string
  zip?: string
  listPrice?: number
  primaryPhotoUrl?: string
  listingUrl?: string
  mlsNumber?: string
  listingAgentName?: string
  listingAgentPhone?: string
  listingAgentEmail?: string
  listingAgentCompany?: string
  schedulingMethod?: 'showingtime' | 'call_agent' | 'other'
  schedulingInstructions?: string
  suggestedDurationMinutes?: number
  driveTimeFromPrevMinutes?: number
}

export interface CreateTourParams {
  contactId: string
  agentUserId: string
  brokerageId: string
  tourDate: string           // ISO date string YYYY-MM-DD
  startTime: string          // HH:MM
  /** Where the tour begins — buyer agent provides this. Used by AI for
   *  drive-time computation on the first leg. */
  startAddress?: string
  stops: TourStop[]
  aiPlanNarrative?: string
  notes?: string
  /** Pre-computed totals from the AI route optimizer */
  totalDurationMinutes?: number
  totalDriveTimeMinutes?: number
}

export interface ConfirmStopParams {
  tourStopId: string
  showingId: string
  tourId: string
  confirmedTime: string      // ISO timestamp
  accessMethod: string
  accessCode?: string
  accessInstructions?: string
  listingAgentName?: string
  listingAgentPhone?: string
  listingAgentCompany?: string
  schedulingReference?: string
  brokerageId: string
  contactId: string
  agentUserId: string
}

export interface RateStopParams {
  tourStopId: string
  showingId: string
  contactId: string
  brokerageId: string
  agentUserId: string
  listingId?: string
  propertyAddress: string
  listPrice?: number
  city?: string
  zip?: string
  interestLevel: 'love_it' | 'like_it' | 'maybe' | 'no'
  note?: string
}

export interface CompleteTourParams {
  tourId: string
  contactId: string
  brokerageId: string
  agentUserId: string
  agentNote?: string
  stopRatings: Array<{
    tourStopId: string
    showingId: string
    interestLevel: 'love_it' | 'like_it' | 'maybe' | 'no'
    note?: string
    listingId?: string
    propertyAddress: string
    listPrice?: number
    city?: string
    zip?: string
  }>
}

// ─── Lifecycle states ─────────────────────────────────────────────────────────
//
// Canonical tour state machine:
//
//   planned           AI built first draft. Buyer agent reviews. Nothing has
//                     gone out to listing agents yet.
//   scheduling        Agent has dispatched scheduling requests for each stop
//                     (ShowingTime API call OR direct text/email to listing
//                     agent). Awaiting confirmations. Per-stop is_confirmed
//                     flips to true as listing agents reply.
//   confirmed         All stops confirmed (or agent finalized with manual
//                     overrides). Final report sent to buyer + listing
//                     agents. Calendar events written. Tour is locked.
//   in_progress       Tour day — buyer is touring. Per-stop arrived/left
//                     timestamps + ratings flow in.
//   completed         All stops visited. Feedback collected; lifecycle
//                     transition fires for buyer (TOURING → tour reflection).
//   cancelled         Agent or buyer cancelled before in_progress.


function addMinutes(timeStr: string, minutes: number): string {
  const [h, m] = timeStr.split(':').map(Number)
  const total = h * 60 + m + minutes
  const hh = Math.floor(total / 60) % 24
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ─── 1. Load saved properties for tour planning ───────────────────────────────

export async function getSavedPropertiesForTour(contactId: string) {
  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  // saved_properties stores address data directly on the row — no FK to listings.
  // The listings join always returns null, so we select only real columns.
  const { data, error } = await supabase
    .from('saved_properties')
    .select(`
      id,
      listing_id,
      notes,
      ai_match_score,
      match_reasons,
      added_to_tour,
      saved_at,
      property_address,
      mls_number,
      list_price,
      bedrooms,
      bathrooms,
      sqft,
      city,
      state,
      primary_photo_url
    `)
    .eq('contact_id', contactId)
    .eq('brokerage_id', auth.brokerageId)
    .eq('dismissed', false)
    .order('ai_match_score', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, properties: data ?? [] }
}

// ─── 2. Load existing tours for a buyer ───────────────────────────────────────

export async function getBuyerTours(contactId: string) {
  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  const { data, error } = await supabase
    .from('tours')
    .select(`
      id, tour_date, status, notes, ai_plan_narrative,
      all_confirmed, plan_sent_at, created_at,
      tour_stops (
        id, order_index, property_address, city, state, zip,
        listing_id, mls_number, list_price, primary_photo_url,
        listing_url, listing_agent_name, listing_agent_phone,
        listing_agent_email, listing_agent_company,
        scheduling_method, scheduling_instructions,
        access_method, access_code, access_instructions,
        confirmed_time, is_confirmed, suggested_time,
        suggested_duration_minutes, drive_time_from_prev_minutes,
        buyer_interest_level, buyer_note, showing_id,
        time_arrived_at, time_left_at, time_spent_minutes
      )
    `)
    .eq('contact_id', contactId)
    .eq('brokerage_id', auth.brokerageId)
    .order('tour_date', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, tours: data ?? [] }
}

// ─── 3. Create a tour plan ────────────────────────────────────────────────────

export async function createTourPlan(params: CreateTourParams) {
  const {
    contactId,
    tourDate, startTime, startAddress, stops,
    aiPlanNarrative, notes,
    totalDurationMinutes, totalDriveTimeMinutes,
  } = params

  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }
  if (!stops.length) return { success: false, error: 'No stops provided' }

  // Auth gate — ignore caller-supplied agentUserId / brokerageId; derive
  // from session so a hostile caller can't create a tour under a different
  // agent / brokerage.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }

  // ── Financial verification gate (System J3.1) — buyer must be verified
  //    before tours can be created. Previously this gate was UI-only.
  const { data: finProfile } = await supabase
    .from('buyer_financial_profiles')
    .select('verified')
    .eq('contact_id', contactId)
    .eq('brokerage_id', brokerageId)
    .maybeSingle()
  if (!finProfile?.verified) {
    return {
      success: false,
      error: 'Buyer is not financially verified. Complete the verification gate (proof of funds for cash, or pre-approval for financed) before scheduling tours.',
    }
  }

  // Insert tour — `planned` means AI has built the route but the agent
  // has not yet approved/sent it. Approval flips status to `awaiting_confirmation`
  // and writes agent_approved_at; report send fills report_sent_at.
  const { data: tour, error: tourError } = await supabase
    .from('tours')
    .insert({
      contact_id:               contactId,
      buyer_id:                 contactId,
      agent_id:                 agentUserId,
      brokerage_id:             brokerageId,
      tour_date:                tourDate,
      start_time:               startTime,
      start_address:            startAddress ?? null,
      total_duration_minutes:   totalDurationMinutes ?? null,
      total_drive_time_minutes: totalDriveTimeMinutes ?? null,
      status:                   'planned',
      notes:                    notes ?? null,
      ai_plan_narrative:        aiPlanNarrative ?? null,
      plan_sent_at:             new Date().toISOString(),
    })
    .select('id')
    .single()

  if (tourError || !tour) return { success: false, error: tourError?.message ?? 'Failed to create tour' }

  const tourId = tour.id

  // Compute suggested times
  let currentTime = startTime
  const stopsWithTimes = stops.map((stop, i) => {
    // Add drive time from previous stop (skip first)
    if (i > 0 && stop.driveTimeFromPrevMinutes) {
      currentTime = addMinutes(currentTime, stop.driveTimeFromPrevMinutes)
    }
    const suggestedTime = currentTime
    currentTime = addMinutes(currentTime, stop.suggestedDurationMinutes ?? 30)
    return { ...stop, suggestedTime, orderIndex: i }
  })

  // Insert tour_stops
  const stopInserts = stopsWithTimes.map(s => ({
    tour_id:                     tourId,
    brokerage_id:                brokerageId,
    contact_id:                  contactId,
    listing_id:                  s.listingId ?? null,
    order_index:                 s.orderIndex,
    property_address:            s.propertyAddress,
    city:                        s.city ?? null,
    state:                       s.state ?? null,
    zip:                         s.zip ?? null,
    list_price:                  s.listPrice ?? null,
    primary_photo_url:           s.primaryPhotoUrl ?? null,
    listing_url:                 s.listingUrl ?? null,
    mls_number:                  s.mlsNumber ?? null,
    listing_agent_name:          s.listingAgentName ?? null,
    listing_agent_phone:         s.listingAgentPhone ?? null,
    listing_agent_email:         s.listingAgentEmail ?? null,
    listing_agent_company:       s.listingAgentCompany ?? null,
    scheduling_method:           s.schedulingMethod ?? 'call_agent',
    scheduling_instructions:     s.schedulingInstructions ?? null,
    suggested_time:              s.suggestedTime,
    suggested_duration_minutes:  s.suggestedDurationMinutes ?? 30,
    drive_time_from_prev_minutes: s.driveTimeFromPrevMinutes ?? null,
    is_confirmed:                false,
  }))

  const { data: insertedStops, error: stopsError } = await supabase
    .from('tour_stops')
    .insert(stopInserts)
    .select('id, listing_id, order_index')

  if (stopsError) return { success: false, error: stopsError.message }

  // Insert showings (one per stop)
  const showingInserts = (insertedStops ?? []).map((stop, i) => ({
    contact_id:    contactId,
    agent_id:      agentUserId,
    brokerage_id:  brokerageId,
    listing_id:    stopsWithTimes[i]?.listingId ?? null,
    scheduled_date: tourDate,
    status:        'pending',
    tour_id:       tourId,
    sync_source:   'manual' as const,
  }))

  const { data: insertedShowings } = await supabase
    .from('showings')
    .insert(showingInserts.filter(s => s.listing_id))
    .select('id, listing_id')

  // Back-link showing_id onto tour_stops
  if (insertedShowings?.length) {
    for (const showing of insertedShowings) {
      const matchingStop = (insertedStops ?? []).find(
        (ts, i) => stopsWithTimes[i]?.listingId === showing.listing_id
      )
      if (matchingStop) {
        await supabase
          .from('tour_stops')
          .update({ showing_id: showing.id })
          .eq('id', matchingStop.id)
      }
    }
  }

  // Mark saved_properties.added_to_tour = true
  const listingIds = stops.map(s => s.listingId).filter(Boolean) as string[]
  if (listingIds.length) {
    await supabase
      .from('saved_properties')
      .update({ added_to_tour: true })
      .eq('contact_id', contactId)
      .in('listing_id', listingIds)
  }

  // lifecycle_events: tour.planned
  await supabase.from('lifecycle_events').insert({
    brokerage_id:  brokerageId,
    entity_type:   'buyer_lifecycle',
    entity_id:     contactId,
    event_type:    'tour.planned',
    actor_user_id: agentUserId,
    metadata:      { stop_count: stops.length, tour_id: tourId },
  })

  // Advance buyer state → BUYER_TOURING
  await emitLifecycleTransition({
    contactId,
    brokerageId,
    fromState:     'BUYER_TOUR_ELIGIBLE' as any,
    toState:       'BUYER_TOURING' as any,
    triggeredBy:   'agent',
    authorityRole: 'agent',
    userId:        agentUserId,
    sourceSystem:  'tour_planner',
    metadata:      { tour_id: tourId },
  }).catch(() => {})

  // Notification for agent
  await supabase.from('notifications').insert({
    user_id:     agentUserId,
    brokerage_id: brokerageId,
    type:        'tour.plan_created',
    title:       `Tour plan created`,
    body:        `${stops.length} stops planned for ${tourDate}`,
    entity_type: 'tour',
    entity_id:   tourId,
    priority:    'medium',
    channel:     'in_app',
  })

  const stopIds = (insertedStops ?? [])
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    .map(s => s.id)

  return { success: true, tourId, stopCount: stops.length, stopIds }
}

// ─── 4a. Schedule tour stops (dispatch to listing agents) ────────────────────
//
// After AI builds the first draft and the buyer agent reviews it, this is
// the action that goes out to listing agents:
//   - schedulingMethod='showingtime' → ShowingTime API call (deferred — for
//     now we record intent and mark the stop as scheduling-pending)
//   - schedulingMethod='call_agent'  → text message draft to listing_agent_phone
//   - schedulingMethod='other'       → email draft to listing_agent_email
//
// Flips tour status: planned → scheduling. Each stop now has a record of
// outreach so the agent can track who they've contacted vs who still needs
// to be reached. Listing agents reply via:
//   - ShowingTime push back into our system
//   - Direct reply that the agent records via confirmTourStop()
export async function scheduleTourStops(params: {
  tourId:      string
  agentUserId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
}): Promise<{ success: boolean; error?: string; dispatched?: number }> {
  const { tourId } = params
  if (!isValidUUID(tourId)) return { success: false, error: 'Invalid tour ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Load tour + stops
  const [{ data: tour }, { data: stops }] = await Promise.all([
    supabase.from('tours').select('id, contact_id, agent_id, status, tour_date, start_time')
      .eq('id', tourId).eq('brokerage_id', brokerageId).maybeSingle(),
    supabase.from('tour_stops')
      .select('id, listing_id, property_address, listing_agent_name, listing_agent_phone, listing_agent_email, scheduling_method, suggested_time, suggested_duration_minutes')
      .eq('tour_id', tourId)
      .order('order_index', { ascending: true }),
  ])

  if (!tour) return { success: false, error: 'Tour not found' }
  if (tour.status === 'confirmed' || tour.status === 'completed' || tour.status === 'cancelled') {
    return { success: false, error: `Tour is ${tour.status} — cannot reschedule` }
  }

  // Flip status to scheduling
  await supabase.from('tours').update({ status: 'scheduling' }).eq('id', tourId)

  // For each stop, queue the appropriate outbound dispatch. The actual
  // ShowingTime/SMS/email delivery happens in `lib/showings/dispatcher.ts`
  // which reads from showing_dispatches. For now we emit lifecycle events
  // so the UI can show per-stop "scheduling pending" status.
  for (const stop of stops ?? []) {
    await supabase.from('lifecycle_events').insert({
      brokerage_id:  brokerageId,
      entity_type:   'tour_stop',
      entity_id:     stop.id,
      event_type:    'tour_stop.schedule_dispatched',
      actor_user_id: agentUserId,
      metadata: {
        scheduling_method:   stop.scheduling_method ?? 'call_agent',
        listing_agent_phone: stop.listing_agent_phone,
        listing_agent_email: stop.listing_agent_email,
        suggested_time:      stop.suggested_time,
        suggested_duration:  stop.suggested_duration_minutes,
      },
    }).then(() => null, () => null)
  }

  return { success: true, dispatched: (stops ?? []).length }
}

// ─── 4b. Finalize tour (after agent has heard back from listing agents) ──────
//
// After listing agents reply (some via ShowingTime push, some by phone/text
// the agent confirmed manually), the buyer agent finalizes the tour. This
// is the canonical APPROVED state. On finalize:
//   - Status → confirmed
//   - agent_approved_at + agent_approved_by recorded
//   - Tour-level all_confirmed flag set if every stop is confirmed
//   - Calendar events created for each confirmed stop
//   - Final report sent to buyer (portal + optionally email/SMS)
export async function finalizeTour(params: {
  tourId:       string
  agentUserId?:  string  // ignored — derived from session
  brokerageId?:  string  // ignored — derived from session
  /** Channels to send the final report through */
  reportChannels: Array<'portal' | 'email' | 'sms'>
  /** Optional URL to a generated report PDF */
  reportUrl?:   string
  /** Optional final edits the agent made before finalizing */
  editedNotes?: string
  editedNarrative?: string
}): Promise<{ success: boolean; error?: string; calendarEventCount?: number }> {
  const { tourId, reportChannels, reportUrl, editedNotes, editedNarrative } = params
  if (!isValidUUID(tourId)) return { success: false, error: 'Invalid tour ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Load tour + stops
  const [{ data: tour }, { data: stops }] = await Promise.all([
    supabase.from('tours')
      .select('id, contact_id, agent_id, tour_date, start_time')
      .eq('id', tourId).eq('brokerage_id', brokerageId).maybeSingle(),
    supabase.from('tour_stops')
      .select('id, property_address, suggested_time, suggested_duration_minutes, confirmed_time, is_confirmed, listing_id')
      .eq('tour_id', tourId)
      .order('order_index', { ascending: true }),
  ])

  if (!tour) return { success: false, error: 'Tour not found' }

  const allConfirmed = (stops ?? []).every(s => s.is_confirmed)
  const nowIso = new Date().toISOString()

  // Tour update
  const tourUpdates: Record<string, unknown> = {
    status:            'confirmed',
    agent_approved_at: nowIso,
    agent_approved_by: agentUserId,
    all_confirmed:     allConfirmed,
    report_sent_at:    nowIso,
    report_sent_via:   reportChannels,
    report_url:        reportUrl ?? null,
  }
  if (editedNotes !== undefined)     tourUpdates.notes = editedNotes
  if (editedNarrative !== undefined) tourUpdates.ai_plan_narrative = editedNarrative

  const { error: tourErr } = await supabase
    .from('tours').update(tourUpdates).eq('id', tourId)
  if (tourErr) return { success: false, error: tourErr.message }

  // Calendar events for each stop with a confirmed (or suggested) time
  let calendarEventCount = 0
  for (const stop of stops ?? []) {
    const startBase = stop.confirmed_time
      ? new Date(stop.confirmed_time)
      : tour.tour_date && stop.suggested_time
        ? new Date(`${tour.tour_date}T${stop.suggested_time}`)
        : null
    if (!startBase) continue
    const durationMin = stop.suggested_duration_minutes ?? 30
    const endIso = new Date(startBase.getTime() + durationMin * 60_000).toISOString()
    const { error } = await supabase.from('calendar_events').insert({
      brokerage_id:        brokerageId,
      entity_type:         'tour_stop',
      entity_id:           stop.id,
      event_type:          'showing',
      start_at:            startBase.toISOString(),
      end_at:              endIso,
      timezone_name:       'America/New_York',
      is_system_generated: true,
      deadline_notified:   false,
      metadata: {
        tour_id:          tourId,
        contact_id:       tour.contact_id,
        agent_id:         tour.agent_id,
        listing_id:       stop.listing_id,
        property_address: stop.property_address,
      },
    })
    if (!error) calendarEventCount++
  }

  // Buyer-portal message + lifecycle event
  if (reportChannels.includes('portal') && tour.contact_id) {
    await supabase.from('client_portal_messages').insert({
      contact_id: tour.contact_id,
      direction:  'outbound',
      body:       'Your tour is confirmed. Tap to view the itinerary, route, and per-property details.',
      sent_at:    nowIso,
    }).then(() => null, () => null)
  }

  await supabase.from('lifecycle_events').insert({
    brokerage_id:  brokerageId,
    entity_type:   'tour',
    entity_id:     tourId,
    event_type:    'tour.confirmed',
    actor_user_id: agentUserId,
    metadata: {
      report_channels:  reportChannels,
      stop_count:       (stops ?? []).length,
      all_confirmed:    allConfirmed,
      calendar_events:  calendarEventCount,
    },
  }).then(() => null, () => null)

  return { success: true, calendarEventCount }
}

// ─── DEPRECATED — old approval action retained for backwards compatibility ───
/** @deprecated Use finalizeTour() instead. The two-step approve-then-send
 *  flow was wrong: the agent approves AFTER hearing back from listing agents,
 *  which is exactly what finalizeTour does in a single step.
 */
export async function approveTourPlan(params: {
  tourId:       string
  agentUserId:  string
  brokerageId:  string
  editedNotes?: string
  editedNarrative?: string
}) {
  return finalizeTour({
    ...params,
    reportChannels: ['portal'],
  })
}

/** @deprecated Inlined into finalizeTour(). */
export async function sendTourReport(params: {
  tourId:        string
  agentUserId:   string
  brokerageId:   string
  channels:      Array<'portal' | 'email' | 'sms'>
  reportUrl?:    string
}): Promise<{ success: boolean; error?: string }> {
  return finalizeTour({
    tourId:         params.tourId,
    agentUserId:    params.agentUserId,
    brokerageId:    params.brokerageId,
    reportChannels: params.channels,
    reportUrl:      params.reportUrl,
  })
}

// ─── 5. Confirm a single stop ─────────────────────────────────────────────────

export async function confirmTourStop(params: ConfirmStopParams) {
  const {
    tourStopId, showingId, tourId,
    confirmedTime, accessMethod, accessCode, accessInstructions,
    listingAgentName, listingAgentPhone, listingAgentCompany,
    schedulingReference,
  } = params

  if (!isValidUUID(tourStopId) || !isValidUUID(tourId)) {
    return { success: false, error: 'Invalid ID' }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Verify tour stop belongs to caller's brokerage
  const { data: stopRow } = await supabase
    .from('tour_stops')
    .select('id, tour_id, brokerage_id')
    .eq('id', tourStopId)
    .maybeSingle()
  if (!stopRow) return { success: false, error: 'Tour stop not found' }
  if (stopRow.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }
  if (stopRow.tour_id !== tourId) return { success: false, error: 'Tour ID mismatch' }

  const { error: stopError } = await supabase
    .from('tour_stops')
    .update({
      confirmed_time:         confirmedTime,
      access_method:          accessMethod,
      access_code:            accessCode ?? null,
      access_instructions:    accessInstructions ?? null,
      listing_agent_name:     listingAgentName ?? null,
      listing_agent_phone:    listingAgentPhone ?? null,
      listing_agent_company:  listingAgentCompany ?? null,
      scheduling_reference:   schedulingReference ?? null,
      is_confirmed:           true,
    })
    .eq('id', tourStopId)
    .eq('brokerage_id', brokerageId)

  if (stopError) return { success: false, error: stopError.message }

  // Write a calendar_event for the agent — this stop is now confirmed.
  // Only the agent's calendar gets the event here; the contact's calendar is written
  // when the full tour is confirmed and sent (confirmTour below).
  try {
    await supabase.from('calendar_events').insert({
      brokerage_id:        brokerageId,
      entity_type:         'tour_stop',
      entity_id:           tourStopId,
      event_type:          'showing',
      start_at:            confirmedTime,
      is_system_generated: true,
    })
  } catch { /* non-critical */ }

  // Update linked showing
  if (showingId && isValidUUID(showingId)) {
    await supabase
      .from('showings')
      .update({
        scheduled_at:           confirmedTime,
        is_confirmed:           true,
        confirmed_at:           new Date().toISOString(),
        access_method:          accessMethod,
        access_code:            accessCode ?? null,
        access_instructions:    accessInstructions ?? null,
        listing_agent_name:     listingAgentName ?? null,
        listing_agent_phone:    listingAgentPhone ?? null,
        listing_agent_company:  listingAgentCompany ?? null,
        scheduling_reference:   schedulingReference ?? null,
      })
      .eq('id', showingId)
  }

  // Check if all stops confirmed → update tour
  const { data: allStops } = await supabase
    .from('tour_stops')
    .select('is_confirmed')
    .eq('tour_id', tourId)

  const allConfirmed = allStops?.every(s => s.is_confirmed) ?? false

  if (allConfirmed) {
    await supabase
      .from('tours')
      .update({ all_confirmed: true, status: 'confirmed' })
      .eq('id', tourId)

    await supabase.from('notifications').insert({
      user_id:     agentUserId,
      brokerage_id: brokerageId,
      type:        'tour.all_confirmed',
      title:       'All showings confirmed',
      body:        `All stops confirmed for tour on ${tourId}`,
      entity_type: 'tour',
      entity_id:   tourId,
      priority:    'high',
      channel:     'in_app',
    })
  }

  return { success: true, allConfirmed }
}

// ─── 4c. Confirm Tour (legacy entry — routes to finalizeTour) ────────────────
//
// The pre-canonical tour-confirm UI calls confirmTour() with departureTime +
// agentNotes. We now route it through finalizeTour() so the canonical
// per-stop calendar events + buyer-portal message + report-sent timestamps
// happen on every path.

export async function confirmTour(params: {
  tourId: string
  brokerageId?: string  // ignored — derived from session
  contactId: string
  agentUserId?: string  // ignored — derived from session
  departureTime?: string
  agentNotes?: string
  reportChannels?: Array<'portal' | 'email' | 'sms'>
}) {
  if (!isValidUUID(params.tourId) || !isValidUUID(params.contactId)) {
    return { success: false, error: 'Invalid ID' }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const result = await finalizeTour({
    tourId:         params.tourId,
    reportChannels: params.reportChannels ?? ['portal'],
    editedNotes:    params.agentNotes,
  })
  if (!result.success) return result

  // Maintain pre-canonical behaviour: agent notification of "tour confirmed"
  // + buyer-lifecycle event. Both scoped to caller's session brokerage.
  const supabase = createServiceClient()
  try {
    await supabase.from('notifications').insert({
      user_id:      auth.userId,
      brokerage_id: auth.brokerageId,
      type:         'tour.confirmed',
      title:        'Tour confirmed',
      body:         'Your tour is confirmed and calendar events have been created.',
      entity_type:  'tour',
      entity_id:    params.tourId,
      priority:     'high',
      channel:      'in_app',
    })
  } catch { /* non-critical */ }

  await supabase.from('lifecycle_events').insert({
    brokerage_id:  auth.brokerageId,
    entity_type:   'buyer_lifecycle',
    entity_id:     params.contactId,
    event_type:    'tour.confirmed',
    actor_user_id: auth.userId,
    metadata:      { tour_id: params.tourId, departure_time: params.departureTime },
  }).then(() => null, () => null)

  return { success: true }
}

// ─── 5. Rate a stop (day-of) ──────────────────────────────────────────────────

export async function rateTourStop(params: RateStopParams) {
  const { tourStopId, showingId, contactId,
    listingId, propertyAddress, listPrice, city, zip, interestLevel, note } = params

  if (!isValidUUID(tourStopId) || !isValidUUID(contactId)) {
    return { success: false, error: 'Invalid ID' }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Verify tour stop belongs to caller's brokerage and contact
  const { data: stopRow } = await supabase
    .from('tour_stops')
    .select('brokerage_id, contact_id')
    .eq('id', tourStopId)
    .maybeSingle()
  if (!stopRow) return { success: false, error: 'Tour stop not found' }
  if (stopRow.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }
  if (stopRow.contact_id !== contactId) return { success: false, error: 'Contact ID mismatch' }

  await supabase
    .from('tour_stops')
    .update({ buyer_interest_level: interestLevel, buyer_note: note ?? null })
    .eq('id', tourStopId)
    .eq('brokerage_id', brokerageId)

  if (showingId && isValidUUID(showingId)) {
    await supabase
      .from('showings')
      .update({ buyer_interest_level: interestLevel, feedback: note ?? null })
      .eq('id', showingId)
      .eq('brokerage_id', brokerageId)
  }

  const signalWeights: Record<string, number> = { love_it: 10, like_it: 5, maybe: 2, no: -2 }
  await supabase.from('buyer_behavior_log').insert({
    brokerage_id:     brokerageId,
    contact_id:       contactId,
    agent_id:         agentUserId,
    signal_type:      interestLevel,
    listing_id:       listingId ?? null,
    property_address: propertyAddress,
    list_price:       listPrice ?? null,
    city:             city ?? null,
    zip:              zip ?? null,
    signal_value:     signalWeights[interestLevel],
    source:           'agent_dashboard',
    metadata:         { note, tour_stop_id: tourStopId },
  })

  return { success: true }
}

// ─── 6. Complete the tour ─────────────────────────────────────────────────────

export async function completeTour(params: CompleteTourParams) {
  const { tourId, contactId, agentNote, stopRatings } = params

  if (!isValidUUID(tourId) || !isValidUUID(contactId)) {
    return { success: false, error: 'Invalid ID' }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Verify tour belongs to caller's brokerage and contact
  const { data: tourRow } = await supabase
    .from('tours')
    .select('brokerage_id, contact_id')
    .eq('id', tourId)
    .maybeSingle()
  if (!tourRow) return { success: false, error: 'Tour not found' }
  if (tourRow.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }
  if (tourRow.contact_id !== contactId) return { success: false, error: 'Contact ID mismatch' }

  // Batch-update tour_stops — scope each by brokerage_id + tour_id
  for (const r of stopRatings) {
    if (!isValidUUID(r.tourStopId)) continue
    await supabase
      .from('tour_stops')
      .update({ buyer_interest_level: r.interestLevel, buyer_note: r.note ?? null })
      .eq('id', r.tourStopId)
      .eq('tour_id', tourId)
      .eq('brokerage_id', brokerageId)

    if (r.showingId && isValidUUID(r.showingId)) {
      await supabase
        .from('showings')
        .update({
          buyer_interest_level: r.interestLevel,
          feedback:             r.note ?? null,
          status:               'completed',
          completed_at:         new Date().toISOString(),
        })
        .eq('id', r.showingId)
        .eq('brokerage_id', brokerageId)
    }
  }

  // Complete the tour
  await supabase
    .from('tours')
    .update({ status: 'completed', notes: agentNote ?? null })
    .eq('id', tourId)
    .eq('brokerage_id', brokerageId)

  const signalWeights: Record<string, number> = { love_it: 10, like_it: 5, maybe: 2, no: -2 }
  const logInserts = stopRatings.map(r => ({
    brokerage_id:     brokerageId,
    contact_id:       contactId,
    agent_id:         agentUserId,
    signal_type:      r.interestLevel,
    listing_id:       r.listingId ?? null,
    property_address: r.propertyAddress,
    list_price:       r.listPrice ?? null,
    city:             r.city ?? null,
    signal_value:     signalWeights[r.interestLevel],
    source:           'agent_dashboard',
    metadata:         { tour_id: tourId, note: r.note },
  }))
  await supabase.from('buyer_behavior_log').insert(logInserts)

  // Update preference model from new signals
  await updateBuyerPreferences(contactId, brokerageId).catch(() => {})

  // Lifecycle event
  const lovedCount  = stopRatings.filter(r => r.interestLevel === 'love_it').length
  const likedCount  = stopRatings.filter(r => r.interestLevel === 'like_it').length
  await supabase.from('lifecycle_events').insert({
    brokerage_id:  brokerageId,
    entity_type:   'buyer_lifecycle',
    entity_id:     contactId,
    event_type:    'tour.completed',
    actor_user_id: agentUserId,
    metadata:      {
      tour_id:     tourId,
      stops_count: stopRatings.length,
      loved_count: lovedCount,
      liked_count: likedCount,
    },
  })

  return {
    success:    true,
    lovedCount,
    likedCount,
    totalStops: stopRatings.length,
  }
}

// ─── 7. Generate AI plan narrative ───────────────────────────────────────────

export async function generateTourNarrative(params: {
  contactId: string
  brokerageId?: string  // ignored — derived from session
  stops: TourStop[]
  buyerName: string
}) {
  const { contactId, stops, buyerName } = params

  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  // Auth gate — burns paid AI inference. Was previously open: any caller
  // could trigger Claude Opus calls under our API key.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // Verify contact belongs to caller's brokerage
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  try {
    const { generateText, Output } = await import('ai')
    const { z } = await import('zod')

    const stopsText = stops.map((s, i) =>
      `Stop ${i + 1}: ${s.propertyAddress}${s.city ? ', ' + s.city : ''} — $${s.listPrice?.toLocaleString() ?? 'N/A'}`
    ).join('\n')

    const { experimental_output: object } = await generateText({
      model: 'anthropic/claude-opus-4-5',
      experimental_output: Output.object({ schema: z.object({ narrative: z.string() }) }),
      prompt: `You are a real estate tour planning assistant. Write a brief, practical tour narrative (2-3 sentences) for agent ${buyerName}'s buyer.
Tour stops:
${stopsText}

Focus on geography flow, any standout properties, and pacing. Be specific and helpful. No fluff.`,
    })

    return { success: true, narrative: object?.narrative ?? `This tour covers ${stops.length} properties for ${buyerName}. Properties are ordered for efficient routing. Review access instructions for each stop before departure.` }
  } catch {
    return {
      success:   true,
      narrative: `This tour covers ${stops.length} properties for ${buyerName}. Properties are ordered for efficient routing. Review access instructions for each stop before departure.`,
    }
  }
}

// ─── 9. Update tour stop order (manual drag reorder) ─────────────────────────

export async function updateTourStopOrder(
  tourId: string,
  orderedStopIds: string[]
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(tourId)) return { success: false, error: 'Invalid tour ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify tour belongs to caller's brokerage
  const { data: tourRow } = await supabase
    .from('tours').select('brokerage_id').eq('id', tourId).maybeSingle()
  if (!tourRow) return { success: false, error: 'Tour not found' }
  if (tourRow.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  const updates = orderedStopIds
    .filter(id => isValidUUID(id))
    .map((id, idx) =>
      supabase.from('tour_stops')
        .update({ order_index: idx })
        .eq('id', id)
        .eq('tour_id', tourId)
        .eq('brokerage_id', auth.brokerageId)
    )
  const results = await Promise.all(updates)
  const failed = results.find(r => r.error)
  if (failed?.error) return { success: false, error: failed.error.message }
  return { success: true }
}
